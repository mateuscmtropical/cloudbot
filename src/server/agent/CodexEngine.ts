import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';

import type { ProxyCallGate } from '../apps/AppProxy.ts';
import type { AgentEvent } from './AgentEvent.ts';
import type { AgentRunner, TurnRequest } from './AgentRunner.ts';
import { answerCodexRequest } from './answerCodexRequest.ts';
import type { CodexAnswer } from './answerCodexRequest.ts';
import { signalProcessTree } from './ClaudeCliEngine.ts';
import type { SignalAction, SpawnFunction } from './ClaudeCliEngine.ts';
import { CODEX_APPROVAL_POLICY, CODEX_LOCKED_CONFIG, CODEX_SANDBOX_MODE, CODEX_TOOL_TOKEN_VARIABLE, isFileChangeItem, isMcpToolCallItem } from './codexProtocol.ts';
import type { CodexFileChange, CodexMessage, CodexRequestId, CodexThreadItem, CodexTurn } from './codexProtocol.ts';
import type { LoopbackToolServer, LoopbackTurn } from './createLoopbackToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';
import { mapCodexNotification, mapCodexTurnEnd, readItem } from './mapCodexNotification.ts';
import { writeCodexTurnImages } from './writeCodexTurnImages.ts';
import type { CodexTurnImages } from './writeCodexTurnImages.ts';

interface CodexEngineOptions {
    // The absolute path of the codex binary.
    codexPath: string;
    // The CODEX_HOME of a bot. CloudBot owns the folder, and the Codex sign-in and config of the bot live in it.
    codexHomeFor: (botId: string) => string;
    // The environment of the app server. Unset gives PATH only, so no variable of the CloudBot server reaches Codex.
    environment?: Record<string, string> | undefined;
    // More -c overrides, added after the locked ones. Tests point Codex at a fake model server with them.
    extraConfig?: string[] | undefined;
    // Serves the bot's own tools. Unset means a Codex turn has no CloudBot tools.
    loopback?: LoopbackToolServer | undefined;
    // Opens a gated address of a connected server for one turn, the app proxy in production. Unset means a Codex turn
    // gets no connected servers, since a call to the plain address would not be checked again at the proxy.
    callGates?: { openCallGate: (address: string) => ProxyCallGate | undefined } | undefined;
    // How long a review may take before the call is declined. The approval gate waits one hour, so this outlasts it.
    reviewTimeoutMs?: number | undefined;
    // Tests inject fakes here. Production spawns the binary and signals its process group.
    spawnFunction?: SpawnFunction | undefined;
    signalProcess?: ((child: ChildProcess, action: SignalAction) => void) | undefined;
}

interface PendingCall {
    resolve: (message: CodexMessage) => void;
}

interface TurnProgress {
    threadId: string | undefined;
    turnId: string | undefined;
    isSessionReported: boolean;
    isTurnOver: boolean;
    toolCount: number;
    // Commands and file changes asked for. A command asks before its item starts, so the step limit counts the asks.
    approvalCount: number;
    setupError: string | undefined;
}

const DEFAULT_REVIEW_TIMEOUT_MS = 65 * 60 * 1000;
// A stop asks Codex to interrupt the turn first and waits this long. In the spike the turn ended in about 3.5 seconds.
const INTERRUPT_GRACE_MS = 8000;
// After the turn, the app server gets this long to exit once its input closes.
const EXIT_GRACE_MS = 2000;
const TERM_GRACE_MS = 5000;
const KILL_WAIT_MS = 5000;
const PRIVATE_FOLDER_MODE = 0o700;
const CODEX_USER_HOME_SUFFIX = '-home';
const CLIENT_NAME = 'cloudbot';
const CLIENT_VERSION = '0.0.0';
const START_FAILED = 'Codex could not start the turn.';
const STOPPED_EARLY = 'Codex stopped before the turn ended.';
// The setup calls answer at once when Codex works. A Codex that never answers would hold the turn open.
const SETUP_TIMEOUT_MS = 60000;
const SETUP_TIMED_OUT = 'Codex did not answer.';
const APPROVAL_METHODS = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'mcpServer/elicitation/request'];
// Codex reads the loopback token from this variable, so the token is never on the command line. The locked config keeps
// it out of the commands Codex runs.
const TOOL_TOKEN_VARIABLE = CODEX_TOOL_TOKEN_VARIABLE;
// The names ConnectedApps accepts. Anything else is left out, since it would become part of a config key.
const REMOTE_SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
// A bot tool may wait for the owner, such as a secret form, so Codex waits as long as an approval may.
const TOOL_TIMEOUT_SECONDS = 3900;

function buildCodexArguments(extraConfig: string[]): string[] {
    const overrides = [...CODEX_LOCKED_CONFIG, ...extraConfig].flatMap(setting => ['-c', setting]);

    return ['app-server', ...overrides];
}

function parseLine(line: string): CodexMessage | undefined {
    try {
        const parsed: unknown = JSON.parse(line);

        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readId(value: unknown, key: string): string | undefined {
    const record = readRecord(value);
    const inner = readRecord(record[key]);

    return typeof inner.id === 'string' ? inner.id : undefined;
}

function exitsWithin(exited: Promise<unknown>, milliseconds: number): Promise<boolean> {
    const timeout = new Promise<boolean>((resolve) => {
        setTimeout(() => {
            resolve(false);
        }, milliseconds)
            .unref();
    });

    return Promise.race([exited.then(() => true), timeout]);
}

// The bot's own server for Codex. Every call asks first (prompt), so each one comes to CloudBot as a question.
function toolServerConfig(turn: LoopbackTurn): string[] {
    const prefix = `mcp_servers.${PROFILE_SERVER_NAME}`;

    return [
        `${prefix}.url="${turn.mcpUrl}"`,
        `${prefix}.bearer_token_env_var="${TOOL_TOKEN_VARIABLE}"`,
        `${prefix}.default_tools_approval_mode="prompt"`,
        `${prefix}.tool_timeout_sec=${String(TOOL_TIMEOUT_SECONDS)}`,
    ];
}

interface RemoteServer {
    name: string;
    gate: ProxyCallGate;
}

// The owner's connected servers, each at a gated proxy address of this turn. Only http servers are added, under a plain
// name, so a name cannot reach another config key. Every call asks first, like the bot's own server. Each gate is added
// to opened right away, so the caller closes every gate even when a later one fails to open.
function openRemoteServers(request: TurnRequest, callGates: CodexEngineOptions['callGates'], opened: RemoteServer[]): void {
    if (callGates === undefined) {
        return;
    }

    Object.entries(request.mcpServers ?? {})
        .filter((entry): entry is [string, { type: 'http'; url: string }] => entry[1].type === 'http')
        .filter(([name]) => REMOTE_SERVER_NAME_PATTERN.test(name) && name !== PROFILE_SERVER_NAME)
        .forEach(([name, config]) => {
            const gate = callGates.openCallGate(config.url);

            if (gate !== undefined) {
                opened.push({ name, gate });
            }
        });
}

function remoteServerConfig(servers: RemoteServer[]): string[] {
    return servers.flatMap(({ name, gate }) => {
        const prefix = `mcp_servers.${name}`;

        return [
            `${prefix}.url=${JSON.stringify(gate.address)}`,
            `${prefix}.default_tools_approval_mode="prompt"`,
        ];
    });
}

function refuseOnPromptRoute(): Promise<{ isAllowed: false; reason: string }> {
    return Promise.resolve({ isAllowed: false, reason: 'Codex calls are decided by the engine.' });
}

function updatePatch(items: Map<string, CodexThreadItem>, params: unknown): void {
    const record = readRecord(params);
    const itemId = typeof record.itemId === 'string' ? record.itemId : undefined;
    const stored = itemId === undefined ? undefined : items.get(itemId);

    if (itemId === undefined || stored === undefined || !isFileChangeItem(stored) || !Array.isArray(record.changes)) {
        return;
    }

    items.set(itemId, { ...stored, changes: record.changes as CodexFileChange[] });
}

function isPastStepLimit(request: TurnRequest, progress: TurnProgress): boolean {
    return request.maxSteps !== undefined && progress.approvalCount > request.maxSteps;
}

// HOME is a sibling of the Codex home, not the Codex home itself. Then ~ cannot lead to config.toml or auth.json.
function codexUserHomeFor(codexHome: string): string {
    return `${codexHome}${CODEX_USER_HOME_SUFFIX}`;
}

function preparePrivateFolder(folder: string): void {
    // chmod as well, since the umask or an existing folder could leave other modes.
    mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
    chmodSync(folder, PRIVATE_FOLDER_MODE);
}

// Runs each turn in its own `codex app-server`, the route with an approval channel. Every command and file change asks
// CloudBot first (approval policy untrusted), and each question goes to the same review as a Claude tool call.
// Not covered yet, see issue #128: the spending limit and the agent user. The model choices of the owner name Claude models, so Codex keeps its own default model.
class CodexEngine implements AgentRunner {
    private readonly options: CodexEngineOptions;
    private readonly spawnFunction: SpawnFunction;

    constructor(options: CodexEngineOptions) {
        if (!options.codexPath.startsWith('/')) {
            throw new Error('The Codex path must be absolute.');
        }

        this.options = options;
        this.spawnFunction = options.spawnFunction ?? spawn;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        if (request.abortSignal.aborted) {
            return;
        }

        const codexHome = this.options.codexHomeFor(request.botId);
        const userHome = codexUserHomeFor(codexHome);

        preparePrivateFolder(codexHome);
        preparePrivateFolder(userHome);

        const tools = request.tools ?? [];
        // The engine decides each call itself, so the prompt route of the loopback server refuses everything.
        const toolTurn = this.options.loopback === undefined || tools.length === 0
            ? undefined
            : this.options.loopback.grantTurn({ tools, reviewToolCall: refuseOnPromptRoute, disallowedTools: request.disallowedTools, offersPromptTool: false });
        let images: CodexTurnImages | undefined;

        const remoteServers: RemoteServer[] = [];

        // The images are written inside the try, so the tool turn, the gates and the image folder are all cleaned up on any error.
        try {
            openRemoteServers(request, this.options.callGates, remoteServers);
            images = writeCodexTurnImages(codexHome, request.images ?? []);
            yield* this.runProcess(request, codexHome, userHome, toolTurn, remoteServers, images.paths);
        } finally {
            toolTurn?.release();
            remoteServers.forEach((server) => {
                server.gate.close();
            });
            images?.remove();
        }
    }

    private async* runProcess(request: TurnRequest, codexHome: string, userHome: string, toolTurn: LoopbackTurn | undefined, remoteServers: RemoteServer[], imagePaths: string[]): AsyncGenerator<AgentEvent> {
        const tokenVariable = toolTurn === undefined ? {} : { [TOOL_TOKEN_VARIABLE]: toolTurn.token };
        const environment = { PATH: process.env.PATH ?? '', ...this.options.environment, ...request.extraEnvironment, ...tokenVariable, HOME: userHome, CODEX_HOME: codexHome };
        const toolConfig = toolTurn === undefined ? [] : toolServerConfig(toolTurn);
        const args = buildCodexArguments([...toolConfig, ...remoteServerConfig(remoteServers), ...(this.options.extraConfig ?? [])]);
        const child = this.spawnFunction(this.options.codexPath, args, {
            cwd: request.workspaceDir,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            // The app server leads its own process group, so a stop also ends the commands it started.
            detached: process.platform !== 'win32',
        });
        const stdout = child.stdout;

        if (stdout === null) {
            throw new Error('Codex was started without an output pipe.');
        }

        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);
        child.stderr?.resume();

        let hasExited = false;
        const exited = new Promise<void>((resolve) => {
            child.once('exit', () => {
                hasExited = true;
                resolve();
            });
            child.once('error', () => {
                hasExited = true;
                resolve();
            });
        });
        const lines = createInterface({ input: stdout, crlfDelay: Infinity });
        const pending = new Map<CodexRequestId, PendingCall>();
        const items = new Map<string, CodexThreadItem>();
        const decidedItemIds = new Set<string>();
        const progress: TurnProgress = { threadId: undefined, turnId: undefined, isSessionReported: false, isTurnOver: false, toolCount: 0, approvalCount: 0, setupError: undefined };
        const reviewController = new AbortController();
        let nextId = 0;

        const write = (message: unknown): void => {
            if (!hasExited) {
                child.stdin?.write(`${JSON.stringify(message)}\n`);
            }
        };
        const call = (method: string, params: unknown): Promise<CodexMessage> => {
            nextId += 1;
            const id = nextId;
            const answered = new Promise<CodexMessage>((resolve) => {
                pending.set(id, { resolve });
            });

            write({ jsonrpc: '2.0', id, method, params });

            return answered;
        };
        const signalChild = this.options.signalProcess ?? ((target: ChildProcess, action: SignalAction) => {
            signalProcessTree(target, action, undefined);
        });

        let stopping: Promise<void> | undefined;
        const runStop = async (): Promise<void> => {
            reviewController.abort();

            const isTurnRunning = progress.turnId !== undefined && progress.threadId !== undefined && !progress.isTurnOver;

            if (!hasExited && isTurnRunning) {
                void call('turn/interrupt', { threadId: progress.threadId, turnId: progress.turnId });
            }

            child.stdin?.end();

            const graceMs = isTurnRunning ? INTERRUPT_GRACE_MS : EXIT_GRACE_MS;

            if (!hasExited && !(await exitsWithin(exited, graceMs))) {
                signalChild(child, 'TERM');

                if (!(await exitsWithin(exited, TERM_GRACE_MS))) {
                    signalChild(child, 'KILL');
                    await exitsWithin(exited, KILL_WAIT_MS);
                }
            }

            // The group can outlive the app server, so a command it started is ended too.
            if (process.platform !== 'win32') {
                signalChild(child, 'KILL');
            }

            pending.forEach((entry) => {
                entry.resolve({ error: { code: -1, message: STOPPED_EARLY } });
            });
            pending.clear();
            lines.close();
            stdout.destroy();
        };
        const stopChild = (): Promise<void> => {
            stopping ??= runStop();

            return stopping;
        };
        const stop = { isStopped: false };
        const onAbort = (): void => {
            stop.isStopped = true;
            void stopChild();
        };

        request.abortSignal.addEventListener('abort', onAbort, { once: true });
        if (request.abortSignal.aborted) {
            onAbort();
        }

        const answerRequest = (message: CodexMessage): void => {
            const id = message.id;

            if (id === undefined || message.method === undefined) {
                return;
            }

            const review = request.reviewToolCall ?? (() => Promise.resolve({ isAllowed: false as const, reason: 'Tool calls are not reviewed for this turn.' }));
            const isApproval = APPROVAL_METHODS.includes(message.method);

            if (isApproval) {
                progress.approvalCount += 1;
            }

            const approvalNumber = progress.approvalCount;
            const context = {
                reviewToolCall: review,
                signal: reviewController.signal,
                findItem: (itemId: string) => items.get(itemId),
                timeoutMs: this.options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
                workspaceDir: request.workspaceDir,
                codexHome,
                hasStepsLeft: () => request.maxSteps === undefined || approvalNumber <= request.maxSteps,
                toolServer: toolTurn === undefined
                    ? undefined
                    : {
                            name: PROFILE_SERVER_NAME,
                            toolCalls: () => [...items.values()].filter(isMcpToolCallItem),
                            decidedItemIds,
                            blockedTools: request.disallowedTools ?? [],
                            allowCall: (itemId: string, toolName: string, input: unknown) => {
                                toolTurn.allowCall(itemId, toolName, input);
                            },
                        },
                remoteServers: remoteServers.map(({ name, gate }) => ({
                    name,
                    toolCalls: () => [...items.values()].filter(isMcpToolCallItem),
                    decidedItemIds,
                    blockedTools: request.disallowedTools ?? [],
                    // The proxy sends this one call, once. The review names the tool in full, the server knows its own name.
                    allowCall: (itemId: string, toolName: string, input: unknown) => {
                        const plainToolName = toolName.slice(`mcp__${name}__`.length);

                        gate.allowCall(itemId, plainToolName, input);
                    },
                })),
            };

            void answerCodexRequest(message.method, message.params, context)
                .catch((): CodexAnswer => ({ result: { decision: 'decline' } }))
                .then((answer) => {
                    write({ jsonrpc: '2.0', id, ...answer });
                });
        };

        const setup = async (): Promise<void> => {
            const initialized = await call('initialize', {
                clientInfo: { name: CLIENT_NAME, title: null, version: CLIENT_VERSION },
                capabilities: { experimentalApi: false, requestAttestation: false },
            });

            if (initialized.error !== undefined) {
                throw new Error(initialized.error.message);
            }

            write({ jsonrpc: '2.0', method: 'initialized' });

            const threadSettings = {
                cwd: request.workspaceDir,
                approvalPolicy: CODEX_APPROVAL_POLICY,
                sandbox: CODEX_SANDBOX_MODE,
                ...(request.systemPrompt === undefined ? {} : { developerInstructions: request.systemPrompt }),
            };
            const threadAnswer = request.sessionId
                ? await call('thread/resume', { threadId: request.sessionId, ...threadSettings })
                : await call('thread/start', threadSettings);
            const threadId = readId(threadAnswer.result, 'thread');

            if (threadAnswer.error !== undefined || threadId === undefined) {
                throw new Error(threadAnswer.error?.message ?? START_FAILED);
            }

            progress.threadId = threadId;

            const imageInputs = imagePaths.map(path => ({ type: 'localImage', path }));
            const input = [{ type: 'text', text: request.prompt, text_elements: [] }, ...imageInputs];
            const turnAnswer = await call('turn/start', { threadId, input });
            const turnId = readId(turnAnswer.result, 'turn');

            if (turnAnswer.error !== undefined || turnId === undefined) {
                throw new Error(turnAnswer.error?.message ?? START_FAILED);
            }

            progress.turnId = turnId;
        };

        // The line iterator is made before the first call, so an answer that comes at once is not lost.
        const lineIterator = lines[Symbol.asyncIterator]();
        const pendingLines = { [Symbol.asyncIterator]: () => lineIterator };

        const setupTimer = setTimeout(() => {
            if (progress.turnId === undefined && progress.setupError === undefined) {
                progress.setupError = SETUP_TIMED_OUT;
                void stopChild();
            }
        }, SETUP_TIMEOUT_MS);

        setupTimer.unref();
        void setup()
            .finally(() => {
                clearTimeout(setupTimer);
            })
            .catch((error: unknown) => {
                progress.setupError = error instanceof Error ? error.message : START_FAILED;
                // The line loop waits on the output, so the process is stopped to end it.
                void stopChild();
            });

        try {
            // The line reader is an async iterator, so `for await` is the only loop form that fits. Plain loops are banned by lint.
            for await (const line of pendingLines) {
                const message = parseLine(line);

                if (message === undefined) {
                    continue;
                }

                // An answer to a call of CloudBot.
                if (message.method === undefined && message.id !== undefined) {
                    const entry = pending.get(message.id);

                    pending.delete(message.id);
                    entry?.resolve(message);
                }

                // A question from Codex, such as an approval. It is answered without holding up the output.
                if (message.method !== undefined && message.id !== undefined) {
                    answerRequest(message);
                }

                // An ask past the step limit is declined, and the turn ends here. Codex would let the model go on asking.
                if (isPastStepLimit(request, progress) && !progress.isTurnOver && !stop.isStopped) {
                    progress.isTurnOver = true;
                    yield { type: 'turn_limit', limit: 'steps' };

                    break;
                }

                if (!progress.isSessionReported && progress.threadId !== undefined) {
                    progress.isSessionReported = true;
                    yield { type: 'session', sessionId: progress.threadId };
                }

                // While stopping, the lines are still read so the answers arrive. Their events are dropped.
                if (message.method === undefined || message.id !== undefined || stop.isStopped) {
                    continue;
                }

                const turnEvents = this.notificationEvents(message, items, progress, request);

                yield* turnEvents;

                if (progress.isTurnOver) {
                    break;
                }
            }
        } finally {
            request.abortSignal.removeEventListener('abort', onAbort);
            // Every path ends here, so the group is killed even after a clean end: an approved command may still run in it.
            await stopChild();
        }

        if (stop.isStopped) {
            return;
        }

        if (progress.setupError !== undefined) {
            // Keep the untrusted text of Codex on one quoted line in the log.
            const report = JSON.stringify(progress.setupError);

            console.error('Codex could not start the turn:', report);
            yield { type: 'turn_error', message: START_FAILED, isUsageLimit: false };

            return;
        }

        if (!progress.isTurnOver) {
            yield { type: 'turn_error', message: STOPPED_EARLY, isUsageLimit: false };
        }
    }

    // The events of one notification. Items are kept, so a file change approval can find its changes.
    // The step limit counts the commands and file changes, and stops the turn past it.
    private notificationEvents(message: CodexMessage, items: Map<string, CodexThreadItem>, progress: TurnProgress, request: TurnRequest): AgentEvent[] {
        const method = message.method ?? '';

        if (method === 'turn/completed') {
            const turn = readRecord(message.params).turn as CodexTurn | undefined;

            if (turn?.id !== progress.turnId || turn === undefined) {
                return [{ type: 'activity' }];
            }

            progress.isTurnOver = true;

            return mapCodexTurnEnd(turn);
        }

        // The latest state of each item is kept, so a finished tool call is no longer matched to a new question.
        if (method === 'item/started' || method === 'item/completed') {
            const item = readItem(message.params);

            if (item?.id !== undefined) {
                items.set(item.id, item);
            }
        }

        // A newer patch replaces the stored item with a new object, so a review of the older patch can tell it changed.
        if (method === 'item/fileChange/patchUpdated') {
            updatePatch(items, message.params);
        }

        const events = mapCodexNotification(method, message.params);
        const startedTools = events.filter(event => event.type === 'tool_started').length;

        progress.toolCount += startedTools;

        if (request.maxSteps !== undefined && progress.toolCount > request.maxSteps) {
            progress.isTurnOver = true;

            return [...events, { type: 'turn_limit', limit: 'steps' }];
        }

        return events;
    }
}

export { CodexEngine, buildCodexArguments };
export type { CodexEngineOptions };
