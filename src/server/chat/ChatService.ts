import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnImage, TurnRequest } from '../agent/AgentRunner.ts';
import { buildSystemPrompt } from '../agent/buildSystemPrompt.ts';
import {
    PROFILE_SERVER_NAME,
    SHARE_FILE_TOOL_FULL_NAME,
    UPDATE_PROFILE_TOOL_FULL_NAME,
    createProfileToolServer,
} from '../agent/createProfileToolServer.ts';
import { AGENT_WORKSPACE_ROOT, agentWorkspacePath } from '../agent/prepareAgentWorkspace.ts';
import { UNSENT_UPLOAD_MAX_AGE_MS, readUploadRetentionMs, removeOldUploads } from '../attachments/cleanUploads.ts';
import { describeAttachments, readTurnImages } from '../attachments/attachmentPrompt.ts';
import { readMaxUploadBytes, removeFiles, saveFiles } from '../attachments/saveUpload.ts';
import { readMaxShareBytes, shareWorkspaceFile } from '../files/shareFile.ts';
import type { SavedUpload } from '../attachments/saveUpload.ts';
import type { BotStore, QueuedTurnRecord } from '../store/BotStore.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { SetupAction, SetupConversation } from '../setup/SetupConversation.ts';
import { SetupAnswerError } from '../setup/SetupConversation.ts';
import type { StoredUploadRecord } from '../store/schema.ts';
import type { Bot, Message } from '../store/types.ts';
import type {
    AttachmentSummary,
    BotSummary,
    ChatEvent,
    ChatMessage,
    ChatRole,
    FileBody,
    MessageBody,
    PendingUpload,
    TextBody,
} from '../../shared/chatTypes.ts';

interface ChatServiceOptions {
    botStore: BotStore;
    messageStore: MessageStore;
    runner: AgentRunner;
    dataDir: string;
    // Set when the agent runs as its own user. The runner then prepares the folder under AGENT_WORKSPACE_ROOT.
    agentUser?: string | undefined;
    // Caps the bytes a bot's next message may hold. Defaults to CLOUDBOT_MAX_UPLOAD_MB.
    maxUploadBytes?: number | undefined;
    // Caps the size of one file the bot shares. Defaults to 50 MB.
    maxShareBytes?: number | undefined;
    // How long used files stay. Defaults to CLOUDBOT_UPLOAD_RETENTION_DAYS, or 30 days.
    uploadRetentionMs?: number | undefined;
}

interface SharedFileDownload {
    absolutePath: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
}

interface SessionOption {
    sessionId?: string;
}

interface AttemptOutcome {
    failureText: string | undefined;
}

// What a turn learned about its start and about the usage limit. Files come back when the turn
// ends without a session event and without a limit wait, because a wait keeps them for its retry.
interface TurnState {
    agentStarted: boolean;
    // True once the runner reported a rejected rate limit during this turn.
    isRejectedByLimit: boolean;
    rejectedResetsAt: number | undefined;
    limit: UsageLimitState | undefined;
}

interface UsageLimitState {
    resetsAt: number | undefined;
}

// One message's turn: what to send, its files, and the stored message it answers.
interface TurnInput {
    botId: string;
    text: string;
    uploads: SavedUpload[];
    messageId: string | undefined;
}

// A turn waiting in the queue. Its position orders the queue, so a retry can go in front.
interface QueuedTurn extends TurnInput {
    id: string;
    position: number;
}

interface TurnContext {
    botId: string;
    prompt: string;
    abortController: AbortController;
    workspaceDir: string;
    images: TurnImage[];
    systemPrompt: string;
    mcpServers: NonNullable<TurnRequest['mcpServers']>;
    additionalDirectories: string[];
}

type ChatEventListener = (event: ChatEvent) => void;

interface MessagePageOptions {
    limit: number;
    beforeSequence?: number | undefined;
}

const DEFAULT_MESSAGE_PAGE_LIMIT = 50;
const MAX_MESSAGE_PAGE_LIMIT = 200;
// The upload root for agent user mode. The image creates it, owned by cloudbot and readable by the bot group.
const AGENT_UPLOAD_ROOT = '/var/lib/cloudbot-uploads';
const MAX_PENDING_FILES = 10;
const SHARE_DIR_MODE = 0o700;
const FILE_ID_PATTERN = /^[0-9a-f-]{36}$/;
// Used when the runner reports a limit without a reset time.
const USAGE_LIMIT_FALLBACK_WAIT_MS = 5 * 60 * 1000;
// A reset time is kept between these bounds. The minimum stops a retry loop on a past time.
// The maximum stays under the 24.8 day limit of setTimeout.
const USAGE_LIMIT_MIN_WAIT_MS = 60 * 1000;
const USAGE_LIMIT_MAX_WAIT_MS = 8 * 24 * 60 * 60 * 1000;
const CONTINUE_PROMPT = 'Continue.';
const PREVIEW_LENGTH = 80;
const AVATAR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];
const FALLBACK_AVATAR_COLOR = '#3b82f6';

class PendingUploadLimitError extends Error {
    constructor() {
        super('The next message already holds too many files. Send it first.');
        this.name = 'PendingUploadLimitError';
    }
}
class UploadDuringTurnError extends Error {
    constructor() {
        super('Wait until the reply finishes.');
        this.name = 'UploadDuringTurnError';
    }
}

function toChatMessage(storedMessage: Message): ChatMessage {
    // The store keeps the whole MessageBody as JSON, so the content is the body.
    const body = storedMessage.content as MessageBody;

    return {
        id: storedMessage.id,
        botId: storedMessage.botId,
        role: storedMessage.role,
        createdAt: storedMessage.createdAt,
        sequence: storedMessage.sequence,
        body,
    };
}

function previewOf(body: MessageBody): string {
    switch (body.kind) {
        case 'text':
        case 'link':
            return body.text.slice(0, PREVIEW_LENGTH);
        case 'toolActivity':
            return body.summary.slice(0, PREVIEW_LENGTH);
        case 'file':
            return body.name.slice(0, PREVIEW_LENGTH);
        case 'choice':
        case 'codeField':
        case 'secureForm':
            return body.prompt.slice(0, PREVIEW_LENGTH);
    }
}

// A deterministic color per bot, so the same bot keeps its avatar across reloads.
function pickAvatarColor(botId: string): string {
    const characters = Array.from(botId);
    const characterSum = characters.reduce((total, character) => total + character.charCodeAt(0), 0);
    const paletteIndex = characterSum % AVATAR_COLORS.length;

    return AVATAR_COLORS[paletteIndex] ?? FALLBACK_AVATAR_COLOR;
}

// Files that were uploaded and never sent. The age comes from the modification time.
async function findExpiredUploadIds(uploads: SavedUpload[], nowMs: number): Promise<Set<string>> {
    const checkUpload = async (upload: SavedUpload): Promise<string | undefined> => {
        try {
            const fileStats = await stat(upload.absolutePath);

            return nowMs - fileStats.mtimeMs > UNSENT_UPLOAD_MAX_AGE_MS ? upload.id : undefined;
        } catch {
            return upload.id;
        }
    };
    const checkResults = uploads.map(checkUpload);
    const checks = await Promise.all(checkResults);

    const expiredIds = checks.filter((id): id is string => id !== undefined);

    return new Set(expiredIds);
}

// The next message may hold at most MAX_PENDING_FILES files and maxBytes bytes.
function isOverPendingLimit(uploads: SavedUpload[], maxBytes: number): boolean {
    const totalBytes = uploads.reduce((sum, upload) => sum + upload.sizeBytes, 0);

    return uploads.length > MAX_PENDING_FILES || totalBytes > maxBytes;
}

function toPendingUpload(upload: SavedUpload): PendingUpload {
    return { id: upload.id, name: upload.name, sizeBytes: upload.sizeBytes };
}
function toAttachmentSummary(upload: SavedUpload): AttachmentSummary {
    return { name: upload.name, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function buildSessionOption(sessionId: string | null): SessionOption {
    return sessionId === null ? {} : { sessionId };
}

function toStoredUpload(upload: SavedUpload): StoredUploadRecord {
    return {
        id: upload.id,
        name: upload.name,
        absolutePath: upload.absolutePath,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
    };
}

function toQueuedTurnRecord(queuedTurn: QueuedTurn): QueuedTurnRecord {
    const storedUploads = queuedTurn.uploads.map(toStoredUpload);

    return {
        id: queuedTurn.id,
        botId: queuedTurn.botId,
        position: queuedTurn.position,
        messageId: queuedTurn.messageId ?? null,
        text: queuedTurn.text,
        uploads: storedUploads,
    };
}

// The bytes of an upload are not stored, so they are read back from its file. A file that is gone is dropped.
async function readStoredUpload(storedUpload: StoredUploadRecord): Promise<SavedUpload | undefined> {
    try {
        const bytes = await readFile(storedUpload.absolutePath);

        return { ...storedUpload, bytes };
    } catch {
        return undefined;
    }
}

async function restoreQueuedTurn(record: QueuedTurnRecord): Promise<QueuedTurn> {
    const uploadReads = record.uploads.map(readStoredUpload);
    const readUploads = await Promise.all(uploadReads);
    const uploads = readUploads.filter((upload): upload is SavedUpload => upload !== undefined);

    return {
        id: record.id,
        botId: record.botId,
        position: record.position,
        messageId: record.messageId ?? undefined,
        text: record.text,
        uploads,
    };
}

function formatResumeTime(resumeAt: number): string {
    const resumeDate = new Date(resumeAt);
    const isoText = resumeDate.toISOString();

    const minuteText = isoText.slice(0, 16);

    return `${minuteText.replace('T', ' ')} UTC`;
}

function reportBackgroundError(error: unknown): void {
    console.error('The chat queue failed outside a request', error);
}

// Turns one agent event into the stored conversation and the live events.
// Deltas are sent live but never stored. A finished text block is stored and sent
// as a message, so the UI replaces the draft with it and never shows the text twice.
class ChatService {
    private readonly botStore: BotStore;
    private readonly messageStore: MessageStore;
    private readonly runner: AgentRunner;
    private readonly dataDir: string;
    private readonly agentUser: string | undefined;
    private readonly maxPendingBytes: number;
    private readonly uploadRetentionMs: number;
    private readonly maxShareBytes: number;
    private readonly listenersByBot = new Map<string, Set<ChatEventListener>>();
    private readonly runningTurns = new Map<string, AbortController>();
    private setup: SetupConversation | undefined;
    // Files uploaded since the bot's last message. The next message takes them.
    private readonly pendingUploads = new Map<string, SavedUpload[]>();
    // Messages waiting for their turn, in run order. The database holds the same rows.
    private readonly queuedTurns = new Map<string, QueuedTurn[]>();
    // A usage limit wait per bot. Its timer starts the queue again at the reset time.
    private readonly usageWaitTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(options: ChatServiceOptions) {
        this.botStore = options.botStore;
        this.messageStore = options.messageStore;
        this.runner = options.runner;
        this.dataDir = options.dataDir;
        this.agentUser = options.agentUser;
        this.maxPendingBytes = options.maxUploadBytes ?? readMaxUploadBytes(process.env);
        this.uploadRetentionMs = options.uploadRetentionMs ?? readUploadRetentionMs(process.env);
        this.maxShareBytes = options.maxShareBytes ?? readMaxShareBytes();
    }

    // Uploads live outside the agent's writable workspace. The agent reads them and cannot change them.
    uploadDirFor(botId: string): string {
        if (this.agentUser) {
            return agentWorkspacePath(botId, AGENT_UPLOAD_ROOT);
        }

        return join(this.dataDir, 'uploads', botId);
    }

    // Copies of the files the bot shared. They stay in the server's private data, out of the bot's reach.
    shareDirFor(botId: string): string {
        const shareRoot = this.shareRoot();

        return join(shareRoot, botId);
    }

    private shareRoot(): string {
        return join(this.dataDir, 'shared');
    }

    // The stored copy behind a file message. Returns undefined when the message is not a file of this bot.
    async findSharedFile(botId: string, messageId: string): Promise<SharedFileDownload | undefined> {
        const stored = await this.messageStore.getById(messageId);

        if (stored === undefined || stored.botId !== botId) {
            return undefined;
        }

        const body = stored.content as MessageBody;

        if (body.kind !== 'file' || !FILE_ID_PATTERN.test(body.fileId)) {
            return undefined;
        }

        const shareDir = this.shareDirFor(botId);
        const absolutePath = join(shareDir, body.fileId);

        return {
            absolutePath,
            name: body.name,
            mimeType: body.mimeType,
            sizeBytes: body.sizeBytes,
        };
    }

    // Shares one workspace file with the owner. Throws ShareFileError with a message for the model.
    async shareFile(botId: string, requestedPath: string): Promise<{ name: string; sizeBytes: number }> {
        const shareDir = this.shareDirFor(botId);

        await mkdir(shareDir, { recursive: true, mode: SHARE_DIR_MODE });

        const copy = await shareWorkspaceFile({
            workspaceDir: this.workspaceFor(botId),
            requestedPath,
            shareDir,
            maxBytes: this.maxShareBytes,
            fileId: randomUUID(),
        });
        const body: FileBody = { kind: 'file', name: copy.name, mimeType: copy.mimeType, sizeBytes: copy.sizeBytes, fileId: copy.id };

        let storedMessage;

        try {
            storedMessage = await this.messageStore.add({ botId, role: 'assistant', kind: body.kind, content: body });
        } catch (error: unknown) {
            // Without its message nothing points to the copy, so it would stay on the disk for good.
            const copyPath = join(shareDir, copy.id);

            await rm(copyPath, { force: true });

            throw error;
        }

        // Publishing stays outside the try, because the message is stored and the copy must stay.
        this.publish(botId, { type: 'message', message: toChatMessage(storedMessage) });

        return { name: copy.name, sizeBytes: copy.sizeBytes };
    }

    private uploadRoot(): string {
        return this.agentUser ? AGENT_UPLOAD_ROOT : join(this.dataDir, 'uploads');
    }

    // Every path the bot uses starts here, so turns and uploads share one folder.
    workspaceFor(botId: string): string {
        if (this.agentUser) {
            return agentWorkspacePath(botId, AGENT_WORKSPACE_ROOT);
        }

        return join(this.dataDir, 'workspaces', botId);
    }

    // A bot is busy while a turn runs, while messages wait for their turn, or during a usage limit wait.
    isBusy(botId: string): boolean {
        const waitingTurns = this.queuedTurns.get(botId) ?? [];

        return this.runningTurns.has(botId) || this.usageWaitTimers.has(botId) || waitingTurns.length > 0;
    }

    // Saves uploaded files for the bot's next message. Returns undefined for an unknown bot.
    // Throws UploadDuringTurnError while the bot is busy, so the pending files stay empty until it is idle.
    // Throws PendingUploadLimitError when the next message would hold too many files or bytes.
    async saveUploads(botId: string, files: File[]): Promise<AttachmentSummary[] | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        if (this.isBusy(botId)) {
            throw new UploadDuringTurnError();
        }

        const uploadDir = this.uploadDirFor(botId);
        const savedUploads = await saveFiles(uploadDir, files);

        // The bot may have become busy while the files were written. Then they must not join the queue.
        if (this.isBusy(botId)) {
            await removeFiles(savedUploads);

            throw new UploadDuringTurnError();
        }

        const earlierUploads = this.pendingUploads.get(botId) ?? [];
        const pendingUploads = [...earlierUploads, ...savedUploads];

        // The check and the update run in one step, so two uploads cannot both pass the check.
        if (isOverPendingLimit(pendingUploads, this.maxPendingBytes)) {
            await removeFiles(savedUploads);

            throw new PendingUploadLimitError();
        }

        this.pendingUploads.set(botId, pendingUploads);

        return savedUploads.map(toAttachmentSummary);
    }

    // Files waiting for the next message. Returns undefined for an unknown bot.
    async listPendingUploads(botId: string): Promise<PendingUpload[] | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const queuedUploads = this.pendingUploads.get(botId) ?? [];

        return queuedUploads.map(toPendingUpload);
    }

    // Drops one waiting file and deletes it. Returns undefined for an unknown bot, false for an unknown file.
    async removePendingUpload(botId: string, uploadId: string): Promise<boolean | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const queuedUploads = this.pendingUploads.get(botId) ?? [];
        const removedUpload = queuedUploads.find(upload => upload.id === uploadId);

        if (removedUpload === undefined) {
            return false;
        }

        const remainingUploads = queuedUploads.filter(upload => upload.id !== uploadId);

        this.pendingUploads.set(botId, remainingUploads);
        await removeFiles([removedUpload]);

        return true;
    }

    // Removes old files from the upload folders and old shared copies. Used files go after the retention time.
    // Files that were never sent go after one day, and queued messages keep their files.
    // Returns the removed paths. A file left from before a restart counts as used.
    async cleanUploads(nowMs: number = Date.now()): Promise<string[]> {
        const waitingLists = [...this.pendingUploads.values()];
        const waitingUploads = waitingLists.flat();
        const expiredIds = await findExpiredUploadIds(waitingUploads, nowMs);
        // The pending lists are read again after the checks. A turn that took files meanwhile keeps them.
        const expiredUploads = [...this.pendingUploads.entries()].flatMap(([botId, uploads]) => {
            const botExpired = this.isBusy(botId) ? [] : uploads.filter(upload => expiredIds.has(upload.id));
            const keptUploads = uploads.filter(upload => !botExpired.includes(upload));

            this.pendingUploads.set(botId, keptUploads);

            return botExpired;
        });

        await removeFiles(expiredUploads);

        // A bot with a running, queued or waiting turn keeps every file. A pending file is not old by now.
        const isProtected = (botId: string, path: string): boolean => this.isBusy(botId)
            || (this.pendingUploads.get(botId) ?? []).some(upload => upload.absolutePath === path);
        const removedOldPaths = await removeOldUploads({
            uploadRoot: this.uploadRoot(), isProtected, maxAgeMs: this.uploadRetentionMs, nowMs,
        });
        const expiredPaths = expiredUploads.map(upload => upload.absolutePath);

        // Shared copies are not read by the bot, so no turn needs them. Their age counts from the copy.
        const removedSharedPaths = await removeOldUploads({
            uploadRoot: this.shareRoot(), isProtected: () => false, maxAgeMs: this.uploadRetentionMs, nowMs,
        });

        return [...expiredPaths, ...removedOldPaths, ...removedSharedPaths];
    }

    // Puts uploads back in front of the pending ones, so the files of earlier turns stay first.
    private restoreUploads(botId: string, uploads: SavedUpload[]): void {
        const pendingUploads = this.pendingUploads.get(botId) ?? [];

        this.pendingUploads.set(botId, [...uploads, ...pendingUploads]);
    }

    // Rebuilds the queues and the usage limit waits from the database. Call once, after the store is open.
    async resumeQueue(): Promise<void> {
        const storedTurns = await this.botStore.listQueuedTurns();
        const usageWaits = await this.botStore.listUsageWaits();
        const restoreReads = storedTurns.map(restoreQueuedTurn);
        const restoredTurns = await Promise.all(restoreReads);

        restoredTurns.forEach((queuedTurn) => {
            const botTurns = this.queuedTurns.get(queuedTurn.botId) ?? [];

            this.queuedTurns.set(queuedTurn.botId, [...botTurns, queuedTurn]);
        });
        usageWaits.forEach((usageWait) => {
            this.armUsageWaitTimer(usageWait.botId, usageWait.resumeAt);
        });

        const botIdsWithQueue = [...this.queuedTurns.keys()];

        botIdsWithQueue.forEach((botId) => {
            this.startNextQueuedTurn(botId)
                .catch(reportBackgroundError);
        });
    }

    // Clears the usage limit timers. The database keeps the waits, so a new service resumes them.
    dispose(): void {
        this.usageWaitTimers.forEach((timer) => {
            clearTimeout(timer);
        });
        this.usageWaitTimers.clear();
    }

    async listBots(): Promise<BotSummary[]> {
        const bots = await this.botStore.list();
        const summaryPromises = bots.map(bot => this.summarizeBot(bot));

        return Promise.all(summaryPromises);
    }

    setSetup(setup: SetupConversation): void {
        this.setup = setup;
    }

    async answerSetup(botId: string, messageId: string, action: SetupAction, value: string): Promise<ChatMessage> {
        if (this.setup === undefined) {
            throw new SetupAnswerError('Setup is not active.');
        }

        return this.setup.answer(botId, messageId, action, value);
    }

    async postSetupMessage(botId: string, body: MessageBody): Promise<ChatMessage> {
        return this.saveAndPublish(botId, 'assistant', body);
    }

    async updateSetupMessage(messageId: string, body: MessageBody): Promise<ChatMessage> {
        const stored = await this.messageStore.updateContent(messageId, body);

        if (stored === undefined) {
            throw new SetupAnswerError('This setup question does not exist.');
        }

        const message = toChatMessage(stored);

        this.publish(message.botId, { type: 'message', message });

        return message;
    }

    async hasBot(botId: string): Promise<boolean> {
        const bot = await this.botStore.getById(botId);

        return bot !== undefined;
    }

    // Returns one page, oldest first. Pass the sequence of the oldest message you have as beforeSequence to get the page before it.
    async listMessages(
        botId: string,
        page: MessagePageOptions = { limit: DEFAULT_MESSAGE_PAGE_LIMIT },
    ): Promise<ChatMessage[] | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const storedMessages = await this.messageStore.listByBot(botId, page);

        return storedMessages.map(toChatMessage);
    }

    // A message sent while the bot is busy is saved as queued and runs after the work ahead of it.
    async sendMessage(botId: string, text: string): Promise<ChatMessage | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        if (this.setup !== undefined && !this.setup.isDone()) {
            const reminder = this.setup.isStarting()
                ? 'CloudBot is starting. Try again in a moment.'
                : this.setup.isSetupBot(botId)
                    ? 'Finish connecting Claude above to start chatting.'
                    : 'Finish connecting Claude in the CloudBot conversation to start chatting.';

            this.publishTurnState(botId);

            return this.saveAndPublish(botId, 'assistant', { kind: 'text', text: reminder });
        }

        // A queued message waits for the work ahead of it. Its files are taken now, as for any message.
        const isQueued = this.isBusy(botId);

        // The running flag is set before the first await, so two sends cannot both start a turn.
        const abortController = new AbortController();

        if (!isQueued) {
            this.runningTurns.set(botId, abortController);
            this.publishTurnState(botId);
        }

        const turnUploads = this.pendingUploads.get(botId) ?? [];
        const attachmentSummaries = turnUploads.map(toAttachmentSummary);
        const userBody: TextBody = attachmentSummaries.length === 0
            ? { kind: 'text', text }
            : { kind: 'text', text, attachments: attachmentSummaries };
        const storedBody: TextBody = isQueued ? { ...userBody, isQueued: true } : userBody;

        this.pendingUploads.delete(botId);

        let userMessage: ChatMessage;

        try {
            userMessage = await this.saveAndPublish(botId, 'user', storedBody);
        } catch (error: unknown) {
            this.restoreUploads(botId, turnUploads);

            if (!isQueued) {
                this.finishTurn(botId);
            }

            throw error;
        }

        if (isQueued) {
            await this.enqueueTurn(botId, { botId, text, uploads: turnUploads, messageId: userMessage.id }, false);

            // The turn that was running may have ended while the message was saved, so the queue is checked again.
            this.startNextQueuedTurn(botId)
                .catch(reportBackgroundError);

            return userMessage;
        }

        // The turn runs in the background. Its failures are reported to the chat.
        this.runTurn({ botId, text, uploads: turnUploads, messageId: userMessage.id }, abortController)
            .catch((error: unknown) => {
                console.error('The chat turn failed outside the conversation', error);
            });

        return userMessage;
    }

    // Stop ends the running turn, or cancels a usage limit wait together with the queue behind it.
    // Returns undefined for an unknown bot, false when nothing runs or waits.
    async stopTurn(botId: string): Promise<boolean | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const abortController = this.runningTurns.get(botId);

        if (abortController !== undefined) {
            abortController.abort();

            return true;
        }

        if (this.usageWaitTimers.has(botId)) {
            await this.cancelUsageWait(botId);

            return true;
        }

        return false;
    }

    isTurnRunning(botId: string): boolean {
        return this.runningTurns.has(botId);
    }

    subscribe(botId: string, listener: ChatEventListener): () => void {
        const listeners = this.listenersByBot.get(botId) ?? new Set<ChatEventListener>();

        listeners.add(listener);
        this.listenersByBot.set(botId, listeners);

        return () => {
            listeners.delete(listener);
        };
    }

    private async summarizeBot(bot: Bot): Promise<BotSummary> {
        const latestMessages = await this.messageStore.listByBot(bot.id, { limit: 1 });
        const latestMessage = latestMessages[0];
        const lastMessagePreview = latestMessage === undefined
            ? ''
            : previewOf(latestMessage.content as MessageBody);

        return {
            id: bot.id,
            name: bot.name,
            title: bot.title,
            avatarColor: pickAvatarColor(bot.id),
            lastMessagePreview,
            hasUnread: false,
        };
    }

    private publish(botId: string, event: ChatEvent): void {
        const listeners = this.listenersByBot.get(botId);

        listeners?.forEach((listener) => {
            listener(event);
        });
    }

    // Every turn event says busy while the bot runs, waits or has queued work, so a bot never looks idle in between.
    private publishTurnState(botId: string): void {
        this.publish(botId, { type: 'turn', botId, isRunning: this.isBusy(botId) });
    }

    private finishTurn(botId: string): void {
        this.runningTurns.delete(botId);
        this.publishTurnState(botId);
        this.startNextQueuedTurn(botId)
            .catch(reportBackgroundError);
    }

    // Adds a turn to the queue. A retry goes in front, so the message it answers runs first.
    private async enqueueTurn(botId: string, turn: TurnInput, isFirst: boolean): Promise<void> {
        const botTurns = this.queuedTurns.get(botId) ?? [];
        const firstPosition = botTurns[0]?.position ?? 0;
        const lastPosition = botTurns[botTurns.length - 1]?.position ?? 0;
        const position = isFirst ? firstPosition - 1 : lastPosition + 1;
        const queuedTurn: QueuedTurn = { ...turn, id: randomUUID(), position };
        const nextTurns = isFirst ? [queuedTurn, ...botTurns] : [...botTurns, queuedTurn];

        this.queuedTurns.set(botId, nextTurns);

        const queuedTurnRecord = toQueuedTurnRecord(queuedTurn);

        await this.botStore.insertQueuedTurn(queuedTurnRecord);
    }

    // Starts the first queued turn, unless the bot runs a turn or waits for a usage limit.
    private async startNextQueuedTurn(botId: string): Promise<void> {
        if (this.runningTurns.has(botId) || this.usageWaitTimers.has(botId)) {
            return;
        }

        const botTurns = this.queuedTurns.get(botId) ?? [];
        const nextTurn = botTurns[0];

        if (nextTurn === undefined) {
            return;
        }

        // The running flag is set before the first await, so no second queued turn starts meanwhile.
        const abortController = new AbortController();

        this.runningTurns.set(botId, abortController);
        const remainingTurns = botTurns.slice(1);

        this.queuedTurns.set(botId, remainingTurns);
        this.publishTurnState(botId);

        try {
            await this.botStore.deleteQueuedTurn(nextTurn.id);

            if (nextTurn.messageId !== undefined) {
                await this.clearQueuedFlag(nextTurn.messageId);
            }
        } catch (error: unknown) {
            // The turn never runs, so its files go back and the bot must not stay marked as running.
            this.restoreUploads(botId, nextTurn.uploads);
            this.finishTurn(botId);

            throw error;
        }

        await this.runTurn(nextTurn, abortController);
    }

    // The message stops being marked as queued once its turn starts or is cancelled.
    private async clearQueuedFlag(messageId: string): Promise<void> {
        const storedMessage = await this.messageStore.getById(messageId);

        if (storedMessage === undefined) {
            return;
        }

        const body = storedMessage.content as TextBody;
        const updatedMessage = await this.messageStore.updateContent(messageId, { ...body, isQueued: false });

        if (updatedMessage !== undefined) {
            this.publish(updatedMessage.botId, { type: 'message', message: toChatMessage(updatedMessage) });
        }
    }

    // After a usage limit, the same message runs again when no session started. Otherwise "Continue." runs in the session.
    private async waitForUsageLimit(turn: TurnInput, agentStarted: boolean, resetsAt: number | undefined): Promise<void> {
        const resumeTurn: TurnInput = agentStarted
            ? { botId: turn.botId, text: CONTINUE_PROMPT, uploads: [], messageId: undefined }
            : turn;

        await this.enqueueTurn(turn.botId, resumeTurn, true);
        const resumeAt = this.armUsageWaitTimer(turn.botId, resetsAt ?? Date.now() + USAGE_LIMIT_FALLBACK_WAIT_MS);

        await this.botStore.setUsageWait(turn.botId, resumeAt);
        await this.saveAndPublish(turn.botId, 'system', {
            kind: 'text',
            text: `The usage limit was reached. CloudBot continues at ${formatResumeTime(resumeAt)}.`,
        });
    }

    // The one place a usage wait is scheduled, for a new limit and for a wait kept across a restart.
    // Returns the resume time actually used, kept between the minimum and the maximum wait.
    private armUsageWaitTimer(botId: string, requestedResumeAt: number): number {
        const now = Date.now();
        const earliestResumeAt = now + USAGE_LIMIT_MIN_WAIT_MS;
        const latestResumeAt = now + USAGE_LIMIT_MAX_WAIT_MS;
        const notBefore = Math.max(requestedResumeAt, earliestResumeAt);
        const resumeAt = Math.min(notBefore, latestResumeAt);
        const timer = setTimeout(() => {
            this.resumeAfterUsageWait(botId)
                .catch(reportBackgroundError);
        }, resumeAt - now);

        this.usageWaitTimers.set(botId, timer);

        return resumeAt;
    }

    private async resumeAfterUsageWait(botId: string): Promise<void> {
        this.usageWaitTimers.delete(botId);
        await this.botStore.deleteUsageWait(botId);
        await this.startNextQueuedTurn(botId);
        this.publishTurnState(botId);
    }

    // Stop during a wait: the queue is dropped and its messages are no longer marked as queued.
    private async cancelUsageWait(botId: string): Promise<void> {
        const usageWaitTimer = this.usageWaitTimers.get(botId);

        if (usageWaitTimer !== undefined) {
            clearTimeout(usageWaitTimer);
        }

        this.usageWaitTimers.delete(botId);

        const droppedTurns = this.queuedTurns.get(botId) ?? [];
        const droppedMessageIds = droppedTurns.flatMap(turn => (turn.messageId === undefined ? [] : [turn.messageId]));
        const droppedUploads = droppedTurns.flatMap(turn => turn.uploads);

        // The files of the dropped turns, such as a retry the agent never started, go back for the next message.
        this.restoreUploads(botId, droppedUploads);
        this.queuedTurns.delete(botId);
        await this.botStore.deleteQueuedTurnsOfBot(botId);
        await this.botStore.deleteUsageWait(botId);
        const clears = droppedMessageIds.map(messageId => this.clearQueuedFlag(messageId));

        await Promise.all(clears);
        await this.saveAndPublish(botId, 'system', { kind: 'text', text: 'Stopped. The queued messages were not answered.' });
        this.publishTurnState(botId);
    }

    private async saveAndPublish(botId: string, role: ChatRole, body: MessageBody): Promise<ChatMessage> {
        const storedMessage = await this.messageStore.add({ botId, role, kind: body.kind, content: body });
        const chatMessage = toChatMessage(storedMessage);

        this.publish(botId, { type: 'message', message: chatMessage });

        return chatMessage;
    }

    private async runTurn(turn: TurnInput, abortController: AbortController): Promise<void> {
        const { botId, text, uploads } = turn;
        const turnState: TurnState = { agentStarted: false, isRejectedByLimit: false, rejectedResetsAt: undefined, limit: undefined };

        try {
            const bot = await this.botStore.getById(botId);

            if (bot === undefined) {
                return;
            }

            const workspaceDir = this.workspaceFor(botId);

            if (!this.agentUser) {
                await mkdir(workspaceDir, { recursive: true });
            }

            // Stop can arrive during the setup above. Then the runner must not start.
            if (abortController.signal.aborted) {
                return;
            }

            // The profile tool and prompt are built from the bot as it is now, so a
            // change made in the previous turn already applies.
            const profileServer = createProfileToolServer(
                this.botStore,
                botId,
                requestedPath => this.shareFile(botId, requestedPath),
            );
            const prompt = uploads.length === 0 ? text : `${text}\n\n${describeAttachments(uploads)}`;
            const images = readTurnImages(uploads);
            // The upload folder is passed on every turn, so earlier uploads stay readable by path.
            const additionalDirectories = [this.uploadDirFor(botId)];
            const turnContext: TurnContext = {
                additionalDirectories,
                botId,
                prompt,
                abortController,
                workspaceDir,
                images,
                systemPrompt: buildSystemPrompt(bot),
                mcpServers: { [PROFILE_SERVER_NAME]: profileServer },
            };
            const firstAttempt = await this.runAttempt(turnContext, bot.sessionId, turnState);

            // A resumed session that fails before it starts is usually gone, for example
            // after a container rebuild. Start a fresh session once instead of failing every turn.
            if (firstAttempt.failureText !== undefined && turnState.limit === undefined) {
                await this.botStore.setSessionId(botId, null);
                await this.runAttempt(turnContext, null, turnState);
            }
        } catch (error: unknown) {
            const errorBody: TextBody = { kind: 'text', text: describeError(error) };

            await this.saveAndPublish(botId, 'system', errorBody);
        } finally {
            try {
                await this.settleTurnEnd(turn, turnState);
            } finally {
                this.finishTurn(botId);
            }
        }
    }

    // A usage limit schedules the resume. Otherwise files a turn never handed to the agent go back.
    private async settleTurnEnd(turn: TurnInput, turnState: TurnState): Promise<void> {
        if (turnState.limit !== undefined) {
            await this.waitForUsageLimit(turn, turnState.agentStarted, turnState.limit.resetsAt);

            return;
        }

        // A turn that ends without a session event never handed the files to the agent. They go back.
        if (!turnState.agentStarted) {
            this.restoreUploads(turn.botId, turn.uploads);
        }
    }

    // With a session to resume, a failure before the session starts is held back
    // and returned as failureText, so the caller can retry without it.
    private async runAttempt(turnContext: TurnContext, sessionId: string | null, turnState: TurnState): Promise<AttemptOutcome> {
        const { botId } = turnContext;
        const toolNamesById = new Map<string, string>();
        const sessionOption = buildSessionOption(sessionId);
        const turnRequest: TurnRequest = {
            botId,
            workspaceDir: turnContext.workspaceDir,
            prompt: turnContext.prompt,
            images: turnContext.images,
            abortSignal: turnContext.abortController.signal,
            systemPrompt: turnContext.systemPrompt,
            mcpServers: turnContext.mcpServers,
            allowedTools: [UPDATE_PROFILE_TOOL_FULL_NAME, SHARE_FILE_TOOL_FULL_NAME],
            additionalDirectories: turnContext.additionalDirectories,
            ...sessionOption,
        };
        const isResumeAttempt = sessionId !== null;
        let hasSession = false;
        let failureText: string | undefined;

        try {
            for await (const agentEvent of this.runner.runTurn(turnRequest)) {
                if (agentEvent.type === 'session') {
                    hasSession = true;
                    turnState.agentStarted = true;
                }

                // Only a rejected limit means wait. A warning or an allowed status does not stop the turn.
                if (agentEvent.type === 'rate_limit' && agentEvent.status === 'rejected') {
                    turnState.isRejectedByLimit = true;
                    turnState.rejectedResetsAt = agentEvent.resetsAt ?? turnState.rejectedResetsAt;
                }

                // A limit error is waited on, with or without a rejected event before it. It is never held back for a fresh session.
                // The reset time of the rejected event wins over the one the runner copies onto the error.
                if (agentEvent.type === 'turn_error' && (turnState.isRejectedByLimit || agentEvent.isUsageLimit)) {
                    turnState.limit = { resetsAt: turnState.rejectedResetsAt ?? agentEvent.resetsAt };
                }

                if (isResumeAttempt && !hasSession && agentEvent.type === 'turn_error' && turnState.limit === undefined) {
                    failureText = agentEvent.message;

                    continue;
                }

                await this.handleAgentEvent(botId, agentEvent, toolNamesById);
            }
        } catch (error: unknown) {
            if (!isResumeAttempt || hasSession) {
                throw error;
            }

            failureText = describeError(error);
        }

        return { failureText };
    }

    private async handleAgentEvent(botId: string, agentEvent: AgentEvent, toolNamesById: Map<string, string>): Promise<void> {
        switch (agentEvent.type) {
            case 'session':
                await this.botStore.setSessionId(botId, agentEvent.sessionId);

                return;
            case 'text': {
                const textBody: TextBody = { kind: 'text', text: agentEvent.text };

                await this.saveAndPublish(botId, 'assistant', textBody);

                return;
            }
            case 'tool_started':
                toolNamesById.set(agentEvent.toolUseId, agentEvent.toolName);

                return;
            case 'tool_finished': {
                const toolName = toolNamesById.get(agentEvent.toolUseId) ?? 'tool';
                const toolBody: MessageBody = {
                    kind: 'toolActivity',
                    toolName,
                    status: agentEvent.isError ? 'error' : 'done',
                    summary: agentEvent.output,
                };

                await this.saveAndPublish(botId, 'assistant', toolBody);

                return;
            }
            case 'turn_error': {
                const errorBody: TextBody = { kind: 'text', text: agentEvent.message };

                await this.saveAndPublish(botId, 'system', errorBody);

                return;
            }
            case 'text_delta':
                this.publish(botId, { type: 'textDelta', botId, text: agentEvent.text });

                return;
            case 'rate_limit':
            case 'turn_finished':
                return;
        }
    }
}

export { ChatService, DEFAULT_MESSAGE_PAGE_LIMIT, MAX_MESSAGE_PAGE_LIMIT, PendingUploadLimitError, UploadDuringTurnError };
export type { ChatEventListener, ChatServiceOptions, MessagePageOptions, SharedFileDownload };
