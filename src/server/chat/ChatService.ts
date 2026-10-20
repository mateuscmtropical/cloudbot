import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { buildSystemPrompt } from '../agent/buildSystemPrompt.ts';
import { PROFILE_SERVER_NAME, UPDATE_PROFILE_TOOL_FULL_NAME, createProfileToolServer } from '../agent/createProfileToolServer.ts';
import type { BotStore } from '../store/BotStore.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { Bot, Message } from '../store/types.ts';
import type {
    BotSummary,
    ChatEvent,
    ChatMessage,
    ChatRole,
    MessageBody,
    TextBody,
} from '../../shared/chatTypes.ts';

interface ChatServiceOptions {
    botStore: BotStore;
    messageStore: MessageStore;
    runner: AgentRunner;
    dataDir: string;
}

interface SessionOption {
    sessionId?: string;
}

interface AttemptOutcome {
    failureText: string | undefined;
}

// What every attempt of one turn shares. The profile server is built once per turn.
interface TurnContext {
    botId: string;
    prompt: string;
    abortController: AbortController;
    workspaceDir: string;
    systemPrompt: string;
    mcpServers: NonNullable<TurnRequest['mcpServers']>;
}

type ChatEventListener = (event: ChatEvent) => void;

const MESSAGE_PAGE_LIMIT = 200;
const PREVIEW_LENGTH = 80;
const AVATAR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];
const FALLBACK_AVATAR_COLOR = '#3b82f6';

class TurnInProgressError extends Error {
    constructor() {
        super('A turn is already running for this bot.');
        this.name = 'TurnInProgressError';
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

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function buildSessionOption(sessionId: string | null): SessionOption {
    return sessionId === null ? {} : { sessionId };
}

// Turns one agent event into the stored conversation and the live events.
// Deltas are sent live but never stored. A finished text block is stored and sent
// as a message, so the UI replaces the draft with it and never shows the text twice.
class ChatService {
    private readonly botStore: BotStore;
    private readonly messageStore: MessageStore;
    private readonly runner: AgentRunner;
    private readonly dataDir: string;
    private readonly listenersByBot = new Map<string, Set<ChatEventListener>>();
    private readonly runningTurns = new Map<string, AbortController>();

    constructor(options: ChatServiceOptions) {
        this.botStore = options.botStore;
        this.messageStore = options.messageStore;
        this.runner = options.runner;
        this.dataDir = options.dataDir;
    }

    async listBots(): Promise<BotSummary[]> {
        const bots = await this.botStore.list();
        const summaryPromises = bots.map(bot => this.summarizeBot(bot));

        return Promise.all(summaryPromises);
    }

    async hasBot(botId: string): Promise<boolean> {
        const bot = await this.botStore.getById(botId);

        return bot !== undefined;
    }

    async listMessages(botId: string): Promise<ChatMessage[] | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const storedMessages = await this.messageStore.listByBot(botId, { limit: MESSAGE_PAGE_LIMIT });

        return storedMessages.map(toChatMessage);
    }

    // Throws TurnInProgressError when the bot is already answering.
    async sendMessage(botId: string, text: string): Promise<ChatMessage | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        if (this.runningTurns.has(botId)) {
            throw new TurnInProgressError();
        }

        // The running flag is set before the first await, so two sends cannot both pass the check.
        const abortController = new AbortController();

        this.runningTurns.set(botId, abortController);
        this.publish(botId, { type: 'turn', botId, isRunning: true });

        let userMessage: ChatMessage;

        try {
            userMessage = await this.saveAndPublish(botId, 'user', { kind: 'text', text });
        } catch (error: unknown) {
            this.finishTurn(botId);

            throw error;
        }

        // The turn runs in the background. Its failures are reported to the chat.
        this.runTurn(botId, text, abortController)
            .catch((error: unknown) => {
                console.error('The chat turn failed outside the conversation', error);
            });

        return userMessage;
    }

    // Returns undefined for an unknown bot, false when no turn is running.
    async stopTurn(botId: string): Promise<boolean | undefined> {
        const bot = await this.botStore.getById(botId);

        if (bot === undefined) {
            return undefined;
        }

        const abortController = this.runningTurns.get(botId);

        if (abortController === undefined) {
            return false;
        }

        abortController.abort();

        return true;
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

    private finishTurn(botId: string): void {
        this.runningTurns.delete(botId);
        this.publish(botId, { type: 'turn', botId, isRunning: false });
    }

    private async saveAndPublish(botId: string, role: ChatRole, body: MessageBody): Promise<ChatMessage> {
        const storedMessage = await this.messageStore.add({ botId, role, kind: body.kind, content: body });
        const chatMessage = toChatMessage(storedMessage);

        this.publish(botId, { type: 'message', message: chatMessage });

        return chatMessage;
    }

    private async runTurn(botId: string, prompt: string, abortController: AbortController): Promise<void> {
        try {
            const bot = await this.botStore.getById(botId);

            if (bot === undefined) {
                return;
            }

            const workspaceDir = join(this.dataDir, 'workspaces', botId);

            await mkdir(workspaceDir, { recursive: true });

            // Stop can arrive during the setup above. Then the runner must not start.
            if (abortController.signal.aborted) {
                return;
            }

            // The profile tool and prompt are built from the bot as it is now, so a
            // change made in the previous turn already applies.
            const profileServer = createProfileToolServer(this.botStore, botId);
            const turnContext: TurnContext = {
                botId,
                prompt,
                abortController,
                workspaceDir,
                systemPrompt: buildSystemPrompt(bot),
                mcpServers: { [PROFILE_SERVER_NAME]: profileServer },
            };
            const firstAttempt = await this.runAttempt(turnContext, bot.sessionId);

            // A resumed session that fails before it starts is usually gone, for example
            // after a container rebuild. Start a fresh session once instead of failing every turn.
            if (firstAttempt.failureText !== undefined) {
                await this.botStore.setSessionId(botId, null);
                await this.runAttempt(turnContext, null);
            }
        } catch (error: unknown) {
            const errorBody: TextBody = { kind: 'text', text: describeError(error) };

            await this.saveAndPublish(botId, 'system', errorBody);
        } finally {
            this.finishTurn(botId);
        }
    }

    // With a session to resume, a failure before the session starts is held back
    // and returned as failureText, so the caller can retry without it.
    private async runAttempt(turnContext: TurnContext, sessionId: string | null): Promise<AttemptOutcome> {
        const { botId } = turnContext;
        const toolNamesById = new Map<string, string>();
        const sessionOption = buildSessionOption(sessionId);
        const turnRequest: TurnRequest = {
            botId,
            workspaceDir: turnContext.workspaceDir,
            prompt: turnContext.prompt,
            abortSignal: turnContext.abortController.signal,
            systemPrompt: turnContext.systemPrompt,
            mcpServers: turnContext.mcpServers,
            allowedTools: [UPDATE_PROFILE_TOOL_FULL_NAME],
            ...sessionOption,
        };
        const isResumeAttempt = sessionId !== null;
        let hasSession = false;
        let failureText: string | undefined;

        try {
            for await (const agentEvent of this.runner.runTurn(turnRequest)) {
                if (agentEvent.type === 'session') {
                    hasSession = true;
                }

                if (isResumeAttempt && !hasSession && agentEvent.type === 'turn_error') {
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

export { ChatService, TurnInProgressError };
export type { ChatEventListener, ChatServiceOptions };
