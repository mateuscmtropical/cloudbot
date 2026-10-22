import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import type { AgentEvent } from './AgentEvent.ts';
import type { AgentRunner, ToolCall, ToolCallDecision, TurnRequest } from './AgentRunner.ts';
import { signalProcessTree } from './ClaudeCliEngine.ts';
import type { SignalAction, SpawnFunction } from './ClaudeCliEngine.ts';
import type { LoopbackToolServer, LoopbackTurn } from './createLoopbackToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';
import { prepareAgentWorkspace } from './prepareAgentWorkspace.ts';

interface AcpEngineOptions {
    // The name the chat shows, such as Gemini.
    label: string;
    // The absolute path of the agent CLI and the arguments that start its ACP server.
    command: string;
    args: string[];
    // The HOME of the agent for a bot. CloudBot owns the folder, and the agent keeps its sign-in and config there.
    homeFor: (botId: string) => string;
    // Folders the agent loads its sign-in and config from, as absolute paths or folder names such as .gemini. A question
    // that names one is refused without a review, since a write there could run a program without a review next turn.
    protectedFolders?: string[] | undefined;
    // The session mode that asks before each tool, for an agent whose default mode accepts some calls by itself.
    askModeId?: string | undefined;
    // Some agents need an authenticate call with their cached sign-in before a session, such as cursor_login.
    authMethodId?: string | undefined;
    // More variables for the agent, such as one that turns off its update check.
    environment?: Record<string, string> | undefined;
    // Serves the bot's own tools over MCP. Each call is reviewed there, since ACP agents send no call id.
    loopback?: LoopbackToolServer | undefined;
    // Starts the agent as the agent user. The HOME is then the agent user's own, and homeFor is unused.
    launch?: AcpLaunch | undefined;
    reviewTimeoutMs?: number | undefined;
    // Tests inject fakes here.
    spawnFunction?: SpawnFunction | undefined;
    signalProcess?: ((child: ChildProcess, action: SignalAction) => void) | undefined;
}

interface AcpLaunch {
    spawnFunction: SpawnFunction;
    signalProcess: (child: ChildProcess, action: SignalAction) => void;
}

interface AcpMessage {
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: { message?: string };
}

interface AcpToolCall {
    toolCallId?: string;
    title?: string;
    kind?: string | null;
    name?: string;
    status?: string;
    rawInput?: unknown;
    locations?: { path?: string }[];
}

interface AcpPermissionOption {
    optionId: string;
    kind: string;
}

interface PendingRequest {
    resolve: (message: AcpMessage) => void;
}

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_REVIEW_TIMEOUT_MS = 65 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120 * 1000;
const AUTHENTICATE_TIMEOUT_MS = 30 * 1000;
const CANCEL_GRACE_MS = 8000;
const PRIVATE_FOLDER_MODE = 0o700;
// The input fields that hold the text a file edit writes, not a path or a command.
const EDIT_TEXT_FIELDS = new Set(['content', 'text', 'new_string', 'old_string', 'newText', 'oldText', 'new_str', 'old_str']);
const REVIEW_FAILED_REASON = 'CloudBot could not review this call, so it was refused.';

function readRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, ...names: string[]): string | undefined {
    const found = names.map(name => record[name])
        .find(value => typeof value === 'string');

    return typeof found === 'string' ? found : undefined;
}

// The ACP tool kind decides which CloudBot rule reviews the call, so the command floor checks commands and paths
// the same way as for Claude. A kind the engine does not know is reviewed under its own name.
function toReviewedCall(toolCall: AcpToolCall): ToolCall {
    const input = readRecord(toolCall.rawInput);
    const path = toolCall.locations?.[0]?.path ?? readString(input, 'path', 'file_path', 'filePath', 'filepath', 'absolute_path', 'abs_path', 'file');
    const title = toolCall.title ?? '';

    switch (toolCall.kind) {
        case 'execute':
            return { toolName: 'Bash', input: { command: readString(input, 'command', 'cmd', 'script') ?? title } };
        case 'edit':
            return { toolName: 'Write', input: { ...input, file_path: path ?? '' } };
        case 'delete':
            return { toolName: 'Bash', input: { command: `rm -- ${path ?? title}` } };
        case 'move':
            return { toolName: 'Bash', input: { command: `mv -- ${title}` } };
        case 'read':
            return { toolName: 'Read', input: { file_path: path ?? title } };
        case 'search':
            return { toolName: 'Grep', input: { pattern: readString(input, 'pattern', 'query') ?? title, ...(path === undefined ? {} : { path }) } };
        case 'fetch':
            return { toolName: 'WebFetch', input: { url: readString(input, 'url') ?? title } };
        default:
            return { toolName: `acp__${toolCall.name ?? 'other'}`, input: { title, input } };
    }
}

// Some agents send an unset field as null, which must not replace what an earlier update said.
function dropMissing(record: Record<string, unknown>): Record<string, unknown> {
    const entries = Object.entries(record)
        .filter(([, value]) => value !== undefined && value !== null);

    return Object.fromEntries(entries);
}

// Joins what is known about a call with what a newer message says. The input is joined one level deep, so a
// message that carries only part of it keeps the command or path from before.
function mergeCall(known: AcpToolCall | undefined, newer: AcpToolCall): AcpToolCall {
    const knownInput = readRecord(known?.rawInput);
    const newerRecord = readRecord(newer.rawInput);
    const newerInput = dropMissing(newerRecord);

    return { ...known, ...dropMissing(newer as Record<string, unknown>), rawInput: { ...knownInput, ...newerInput } };
}

// A call with no kind but a command is reviewed as the command it is, so the command floor sees it.
function withKind(toolCall: AcpToolCall): AcpToolCall {
    const input = readRecord(toolCall.rawInput);
    const command = readString(input, 'command', 'cmd', 'script');
    const hasNoKind = toolCall.kind === undefined || toolCall.kind === null;

    return hasNoKind && command !== undefined ? { ...toolCall, kind: 'execute' } : toolCall;
}

function escapeForPattern(text: string): string {
    return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// This is a floor, not a parser. A path the command builds at run time gets past it, and the review still sees it.
function namesProtectedFolder(toolCall: AcpToolCall, protectedFolders: string[]): boolean {
    // The text a file edit writes is left out, so a README line or a .gitignore entry that names a folder is reviewed.
    const rawInput = readRecord(toolCall.rawInput);
    const kept = Object.entries(rawInput)
        .filter(([name]) => !EDIT_TEXT_FIELDS.has(name));
    const input = Object.fromEntries(kept);
    const named = { title: toolCall.title, locations: toolCall.locations, input };
    const text = JSON.stringify(named)
        .replaceAll('\\\\', '/')
        // Escaped line breaks and tabs in the JSON text separate words as spaces do.
        .replaceAll(/\\[nrt]/g, ' ')
        .toLowerCase();

    return protectedFolders.some((folder) => {
        const name = folder.toLowerCase();

        if (name.startsWith('/')) {
            return text.includes(name);
        }

        // A bare name matches unless a word character, a dot or a dash touches it, so `>.gemini/a` and `cd .gemini;` match.
        const pattern = new RegExp(`(?<![\\w.-])${escapeForPattern(name)}(?![\\w-])`);

        return pattern.test(text);
    });
}

function pickOption(options: AcpPermissionOption[], isAllowed: boolean): string | undefined {
    const wanted = isAllowed ? 'allow_once' : 'reject_once';
    const found = options.find(option => option.kind === wanted);

    return found?.optionId;
}

function preparePrivateFolder(folder: string): void {
    mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    chmodSync(folder, PRIVATE_FOLDER_MODE);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, fallback: T): Promise<T> {
    const timeout = new Promise<T>((resolve) => {
        setTimeout(() => {
            resolve(fallback);
        }, milliseconds)
            .unref();
    });

    return Promise.race([promise, timeout]);
}

// Runs a turn on an agent that speaks the Agent Client Protocol over stdio, such as the Gemini or Copilot CLI.
// The agent asks before each command, edit or fetch (session/request_permission), and each question goes to the same
// review as a Claude tool call. The client offers no file system and no terminal, and any other request is refused.
class AcpEngine implements AgentRunner {
    private readonly options: AcpEngineOptions;

    constructor(options: AcpEngineOptions) {
        if (!options.command.startsWith('/')) {
            throw new Error(`The ${options.label} path must be absolute.`);
        }

        this.options = options;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        if (request.abortSignal.aborted) {
            return;
        }

        // The agent user runs in the bot's shared workspace, which only the server can make, as for the Claude engine.
        if (this.options.launch !== undefined) {
            try {
                await prepareAgentWorkspace(request.workspaceDir);
            } catch (error: unknown) {
                console.error('Could not prepare the agent workspace:', error);
                yield { type: 'turn_error', message: 'Could not prepare the agent workspace. Please try again.', isUsageLimit: false };

                return;
            }
        }

        const tools = request.tools ?? [];
        const reviewToolCall = request.reviewToolCall ?? ((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: false, reason: REVIEW_FAILED_REASON }));
        const toolTurn = this.options.loopback === undefined || tools.length === 0
            ? undefined
            : this.options.loopback.grantTurn({ tools, reviewToolCall, disallowedTools: request.disallowedTools, offersPromptTool: false, reviewsEachCall: true });

        try {
            yield* this.runProcess(request, toolTurn, reviewToolCall, false);
        } finally {
            toolTurn?.release();
        }
    }

    // Opens a session and stops before any prompt, so the setup chat can tell whether the sign-in still works.
    async isSignedIn(botId: string, workspaceDir: string): Promise<boolean | undefined> {
        const request = { botId, workspaceDir, prompt: '', abortSignal: new AbortController().signal };
        const deny = (): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: false, reason: REVIEW_FAILED_REASON });
        const events: AgentEvent[] = [];

        // The events are an async iterator, so `for await` is the only loop form that fits.
        for await (const event of this.runProcess(request, undefined, deny, true)) {
            events.push(event);
        }

        if (events.some(event => event.type === 'session')) {
            return true;
        }

        const failure = events.find(event => event.type === 'turn_error');

        return failure?.type === 'turn_error' && failure.message.includes('not signed in') ? false : undefined;
    }

    private async* runProcess(request: TurnRequest, toolTurn: LoopbackTurn | undefined, reviewToolCall: NonNullable<TurnRequest['reviewToolCall']>, isCheck: boolean): AsyncGenerator<AgentEvent> {
        const launch = this.options.launch;
        const home = launch === undefined ? this.options.homeFor(request.botId) : undefined;

        if (home !== undefined) {
            preparePrivateFolder(home);
        }

        const environment = { PATH: process.env.PATH ?? '', ...this.options.environment, ...request.extraEnvironment, ...(home === undefined ? {} : { HOME: home }) };
        const spawnFunction = launch?.spawnFunction ?? this.options.spawnFunction ?? spawn;
        const signalChild = this.options.signalProcess ?? launch?.signalProcess ?? ((target: ChildProcess, action: SignalAction) => {
            signalProcessTree(target, action, undefined);
        });
        const child = spawnFunction(this.options.command, this.options.args, {
            cwd: request.workspaceDir,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        const stdout = child.stdout;

        if (stdout === null) {
            throw new Error(`${this.options.label} was started without an output pipe.`);
        }

        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);
        child.stderr?.resume();

        const exited = new Promise<void>((resolve) => {
            child.once('exit', () => {
                resolve();
            });
            child.once('error', () => {
                resolve();
            });
        });
        const pending = new Map<string | number, PendingRequest>();
        // An object stream holds the events, so the generator reads them with `for await` as they come.
        const queue = new PassThrough({ objectMode: true });
        const reviewController = new AbortController();
        let nextId = 1;
        let permissionCount = 0;
        let currentSessionId = '';
        // A loaded session replays its history as updates. Those were shown before, so they are dropped.
        let isLoading = false;
        const knownCalls = new Map<string, AcpToolCall>();
        const remember = (toolCall: AcpToolCall): void => {
            if (toolCall.toolCallId !== undefined) {
                const before = knownCalls.get(toolCall.toolCallId);
                const merged = mergeCall(before, toolCall);

                knownCalls.set(toolCall.toolCallId, merged);
            }
        };

        const push = (event: AgentEvent): void => {
            if (!queue.writableEnded) {
                queue.write(event);
            }
        };
        const send = (message: Record<string, unknown>): void => {
            child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
        };
        // A prompt runs as long as the turn and its reviews, so it passes 0 for no answer timeout.
        const call = (method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<AcpMessage> => {
            const id = nextId;

            nextId += 1;
            const answered = new Promise<AcpMessage>((resolve) => {
                pending.set(id, { resolve });
            });

            send({ id, method, params });

            const failed = exited.then(() => ({ error: { message: `${this.options.label} stopped.` } }));
            const first = Promise.race([answered, failed]);

            return timeoutMs > 0 ? withTimeout(first, timeoutMs, { error: { message: `${this.options.label} did not answer.` } }) : first;
        };

        const answerPermission = async (id: string | number, params: Record<string, unknown>): Promise<void> => {
            const asked = readRecord(params.toolCall) as AcpToolCall;
            // A permission question may carry only part of the call. The tool_call updates before it hold the rest.
            const known = asked.toolCallId === undefined ? undefined : knownCalls.get(asked.toolCallId);
            const merged = mergeCall(known, asked);
            const toolCall = withKind(merged);
            const options = Array.isArray(params.options) ? params.options as AcpPermissionOption[] : [];

            permissionCount += 1;

            const isOverLimit = request.maxSteps !== undefined && permissionCount > request.maxSteps;
            const isProtected = namesProtectedFolder(toolCall, this.options.protectedFolders ?? []);
            const reviewed = toReviewedCall(toolCall);
            const review = (): Promise<ToolCallDecision> => {
                const reviewing = reviewToolCall(reviewed, reviewController.signal)
                    .catch(() => ({ isAllowed: false as const, reason: REVIEW_FAILED_REASON }));

                return withTimeout(reviewing, this.options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, { isAllowed: false, reason: REVIEW_FAILED_REASON });
            };
            const refusal = isOverLimit ? 'The step limit was reached.' : 'This call names a folder that holds the sign-in or config of the agent.';
            const decision: ToolCallDecision = isOverLimit || isProtected ? { isAllowed: false, reason: refusal } : await review();
            const optionId = pickOption(options, decision.isAllowed && !request.abortSignal.aborted);

            // Without a matching option the question is cancelled, which the agent treats as a refusal.
            send({ id, result: { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } });

            if (isOverLimit) {
                push({ type: 'turn_limit', limit: 'steps' });
                send({ method: 'session/cancel', params: { sessionId: currentSessionId } });
            }
        };

        const handleUpdate = (params: Record<string, unknown>): void => {
            const update = readRecord(params.update);
            const kind = update.sessionUpdate;

            if (isLoading) {
                return;
            }

            if (kind === 'agent_message_chunk') {
                const content = readRecord(update.content);
                const text = readString(content, 'text');

                if (text !== undefined) {
                    push({ type: 'text_delta', text });
                }

                return;
            }

            if (kind === 'tool_call') {
                const toolCall = update as AcpToolCall;

                remember(toolCall);
                const reviewed = toReviewedCall(toolCall);

                push({ type: 'tool_started', toolUseId: toolCall.toolCallId ?? '', toolName: reviewed.toolName, input: reviewed.input });

                return;
            }

            if (kind === 'tool_call_update') {
                const toolCall = update as AcpToolCall;

                remember(toolCall);

                if (toolCall.status === 'completed' || toolCall.status === 'failed') {
                    push({ type: 'tool_finished', toolUseId: toolCall.toolCallId ?? '', isError: toolCall.status === 'failed', output: '' });
                }

                return;
            }

            push({ type: 'activity' });
        };

        const lines = createInterface({ input: stdout, crlfDelay: Infinity });

        lines.on('line', (line) => {
            let message: AcpMessage;

            try {
                message = JSON.parse(line) as AcpMessage;
            } catch {
                return;
            }

            if (message.method === undefined && message.id !== undefined) {
                pending.get(message.id)
                    ?.resolve(message);
                pending.delete(message.id);

                return;
            }

            const params = message.params ?? {};

            if (message.method === 'session/update') {
                handleUpdate(params);

                return;
            }

            if (message.id === undefined) {
                return;
            }

            if (message.method === 'session/request_permission') {
                void answerPermission(message.id, params);

                return;
            }

            // CloudBot offers no file system, terminal or other client method, so the agent uses its own tools, which ask first.
            send({ id: message.id, error: { code: -32601, message: 'Method not found.' } });
        });

        const stop = async (): Promise<void> => {
            reviewController.abort();

            if (currentSessionId !== '') {
                send({ method: 'session/cancel', params: { sessionId: currentSessionId } });
            }

            const exitedTrue = exited.then(() => true);
            const hasExited = await withTimeout(exitedTrue, CANCEL_GRACE_MS, false);

            if (!hasExited) {
                signalChild(child, 'TERM');
                const hasEnded = await withTimeout(exitedTrue, 2000, false);

                if (!hasEnded) {
                    signalChild(child, 'KILL');
                }
            }
        };
        const onAbort = (): void => {
            void stop();
        };

        request.abortSignal.addEventListener('abort', onAbort, { once: true });

        const runPrompt = async (): Promise<void> => {
            const initialized = await call('initialize', {
                protocolVersion: ACP_PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'cloudbot', title: 'CloudBot', version: '1' },
            });

            if (initialized.error !== undefined) {
                push({ type: 'turn_error', message: `${this.options.label} could not start.`, isUsageLimit: false });

                return;
            }

            const notSignedIn = `${this.options.label} is not signed in. Ask me to connect ${this.options.label}.`;

            if (this.options.authMethodId !== undefined) {
                // Without a cached sign-in, Gemini and Grok wait for an interactive login here, so a short wait means not signed in.
                const authenticated = await call('authenticate', { methodId: this.options.authMethodId }, AUTHENTICATE_TIMEOUT_MS);

                if (authenticated.error !== undefined) {
                    push({ type: 'turn_error', message: notSignedIn, isUsageLimit: false });

                    return;
                }
            }

            const capabilities = readRecord(initialized.result?.agentCapabilities);
            const canLoad = capabilities.loadSession === true;
            const canHttpMcp = readRecord(capabilities.mcpCapabilities).http === true;
            const canImage = readRecord(capabilities.promptCapabilities).image === true;
            const mcpServers = toolTurn !== undefined && canHttpMcp
                ? [{ type: 'http', name: PROFILE_SERVER_NAME, url: toolTurn.mcpUrl, headers: [{ name: 'Authorization', value: `Bearer ${toolTurn.token}` }] }]
                : [];
            const sessionParams = { cwd: request.workspaceDir, mcpServers };
            let sessionId = canLoad ? request.sessionId : undefined;

            if (sessionId !== undefined) {
                isLoading = true;
                const loaded = await call('session/load', { ...sessionParams, sessionId });

                isLoading = false;
                sessionId = loaded.error === undefined ? sessionId : undefined;
            }

            if (sessionId === undefined) {
                const created = await call('session/new', sessionParams);
                const createdId = readString(created.result ?? {}, 'sessionId');

                if (createdId === undefined) {
                    const reason = created.error?.message ?? '';
                    // Mistral Vibe answers `Missing API key` before its sign-in.
                    const needsSignIn = /auth|sign|login|api key/i.test(reason);

                    push({ type: 'turn_error', message: needsSignIn ? notSignedIn : `${this.options.label} could not start a session.`, isUsageLimit: false });

                    return;
                }

                sessionId = createdId;
            }

            currentSessionId = sessionId;

            if (this.options.askModeId !== undefined) {
                const modeSet = await call('session/set_mode', { sessionId, modeId: this.options.askModeId });

                // A session that would accept calls without asking is never prompted.
                if (modeSet.error !== undefined) {
                    push({ type: 'turn_error', message: `${this.options.label} could not switch to asking before each tool.`, isUsageLimit: false });

                    return;
                }
            }

            push({ type: 'session', sessionId });

            if (isCheck) {
                return;
            }

            const instructions = request.systemPrompt === undefined ? '' : `${request.systemPrompt}\n\n`;
            const images = canImage ? (request.images ?? []).map(image => ({ type: 'image', mimeType: image.mediaType, data: image.data })) : [];

            if (!canImage && (request.images ?? []).length > 0) {
                push({ type: 'turn_error', message: `This bot runs on ${this.options.label}, which cannot read images in CloudBot.`, isUsageLimit: false });

                return;
            }

            const prompted = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text: `${instructions}${request.prompt}` }, ...images] }, 0);

            if (prompted.error !== undefined) {
                const reason = prompted.error.message ?? '';
                const isUsageLimit = /limit|quota|rate/i.test(reason);

                push({ type: 'turn_error', message: isUsageLimit ? `${this.options.label} reached its usage limit.` : `${this.options.label} stopped with an error.`, isUsageLimit });

                return;
            }

            push({ type: 'turn_finished' });
        };

        const prompting = runPrompt()
            .catch(() => {
                push({ type: 'turn_error', message: `${this.options.label} stopped with an error.`, isUsageLimit: false });
            })
            .finally(() => {
                queue.end();
            });

        try {
            // The queue is an async iterator, so `for await` is the only loop form that fits. Plain loops are banned by lint.
            for await (const event of queue) {
                yield event as AgentEvent;
            }

            await prompting;
        } finally {
            request.abortSignal.removeEventListener('abort', onAbort);
            reviewController.abort();
            queue.end();
            child.stdin?.end();
            const exitedTrue = exited.then(() => true);
            const hasExited = await withTimeout(exitedTrue, 3000, false);

            if (!hasExited) {
                signalChild(child, 'TERM');
                await withTimeout(exitedTrue, 2000, false);
            }

            // Every path ends here, so the group is killed even after a clean end: an approved command may still run in it.
            signalChild(child, 'KILL');
            lines.close();
        }
    }
}

export { AcpEngine, namesProtectedFolder, toReviewedCall };
export type { AcpEngineOptions, AcpLaunch };
