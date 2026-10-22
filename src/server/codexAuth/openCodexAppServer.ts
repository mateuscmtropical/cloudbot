import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { signalProcessTree } from '../agent/ClaudeCliEngine.ts';
import type { SignalAction, SpawnFunction } from '../agent/ClaudeCliEngine.ts';
import { buildCodexArguments, codexUserHomeFor, preparePrivateFolder } from '../agent/CodexEngine.ts';
import type { CodexMessage, CodexRequestId } from '../agent/codexProtocol.ts';

interface CodexAppServerOptions {
    // The absolute path of the codex binary.
    codexPath: string;
    // The bot's CODEX_HOME. CloudBot owns the folder, and the Codex sign-in lives in it.
    codexHome: string;
    // The environment of the app server. Unset gives PATH only, so no variable of the CloudBot server reaches Codex.
    environment?: Record<string, string> | undefined;
    // Tests inject fakes here. Production spawns the binary and signals its process group.
    spawnFunction?: SpawnFunction | undefined;
    signalProcess?: ((child: ChildProcess, action: SignalAction) => void) | undefined;
}

type CodexNotificationHandler = (method: string, params: unknown) => void;

interface CodexAppServer {
    // Sends a request and waits for its answer. A timeout, an exit or a close answers with an error.
    call: (method: string, params: unknown, timeoutMs?: number) => Promise<CodexMessage>;
    onNotification: (handler: CodexNotificationHandler) => void;
    // Resolves when the app server has exited. Carries cliMissing when the binary was not found.
    exited: Promise<{ isMissing: boolean }>;
    close: () => Promise<void>;
}

// The account calls answer at once when Codex works. A Codex that never answers would hold the caller.
const CALL_TIMEOUT_MS = 30000;
const EXIT_GRACE_MS = 2000;
const TERM_GRACE_MS = 5000;
const KILL_WAIT_MS = 5000;
const CLIENT_NAME = 'cloudbot';
const CLIENT_VERSION = '0.0.0';
const NO_ANSWER = 'Codex did not answer.';
const CLOSED = 'Codex closed.';

class CodexAppServerError extends Error {
    readonly reason: 'cliMissing' | 'exitedWithError';

    constructor(reason: 'cliMissing' | 'exitedWithError') {
        super(reason === 'cliMissing' ? 'Codex is missing.' : 'Codex could not start.');
        this.reason = reason;
    }
}

function parseLine(line: string): CodexMessage | undefined {
    try {
        const parsed: unknown = JSON.parse(line);

        return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
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

// Starts the bot's own `codex app-server` for account calls and runs the initialize handshake. Server requests are
// never expected here, so each one is refused. Nothing that Codex prints is logged, since it may hold account details.
async function openCodexAppServer(options: CodexAppServerOptions): Promise<CodexAppServer> {
    const spawnFunction = options.spawnFunction ?? spawn;

    const userHome = codexUserHomeFor(options.codexHome);

    preparePrivateFolder(options.codexHome);
    preparePrivateFolder(userHome);

    const environment = { PATH: process.env.PATH ?? '', ...options.environment, HOME: userHome, CODEX_HOME: options.codexHome };
    const args = buildCodexArguments([]);
    const child = spawnFunction(options.codexPath, args, {
        cwd: options.codexHome,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        // The app server leads its own process group, so a close also ends anything it started.
        detached: process.platform !== 'win32',
    });
    const stdout = child.stdout;

    if (stdout === null) {
        throw new Error('Codex was started without an output pipe.');
    }

    const pending = new Map<CodexRequestId, (message: CodexMessage) => void>();
    const handlers: CodexNotificationHandler[] = [];
    const signalChild = options.signalProcess ?? ((target: ChildProcess, action: SignalAction) => {
        signalProcessTree(target, action, undefined);
    });
    let hasExited = false;
    let nextId = 0;
    let closing: Promise<void> | undefined;

    const exited = new Promise<{ isMissing: boolean }>((resolve) => {
        child.once('exit', () => {
            hasExited = true;
            resolve({ isMissing: false });
        });
        child.once('error', (error: NodeJS.ErrnoException) => {
            hasExited = true;
            resolve({ isMissing: error.code === 'ENOENT' });
        });
    });
    const answerAll = (message: string): void => {
        pending.forEach((resolve) => {
            resolve({ error: { code: -1, message } });
        });
        pending.clear();
    };

    child.stdin?.on('error', () => undefined);
    child.stderr?.resume();
    void exited.then(() => {
        answerAll(CLOSED);
    });

    const write = (message: unknown): void => {
        if (!hasExited) {
            child.stdin?.write(`${JSON.stringify(message)}\n`);
        }
    };
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });

    lines.on('line', (line) => {
        const message = parseLine(line);

        if (message === undefined) {
            return;
        }

        if (message.method !== undefined && message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not supported.' } });

            return;
        }

        if (message.method !== undefined) {
            const method = message.method;

            handlers.forEach((handler) => {
                handler(method, message.params);
            });

            return;
        }

        if (message.id !== undefined) {
            const resolve = pending.get(message.id);

            pending.delete(message.id);
            resolve?.(message);
        }
    });

    const call = (method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<CodexMessage> => {
        if (hasExited || closing !== undefined) {
            return Promise.resolve({ error: { code: -1, message: CLOSED } });
        }

        nextId += 1;
        const id = nextId;

        return new Promise<CodexMessage>((resolve) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ error: { code: -1, message: NO_ANSWER } });
            }, timeoutMs);

            timer.unref();
            pending.set(id, (message) => {
                clearTimeout(timer);
                resolve(message);
            });
            write({ jsonrpc: '2.0', id, method, params });
        });
    };
    const runClose = async (): Promise<void> => {
        child.stdin?.end();

        if (!hasExited && !(await exitsWithin(exited, EXIT_GRACE_MS))) {
            signalChild(child, 'TERM');

            if (!(await exitsWithin(exited, TERM_GRACE_MS))) {
                signalChild(child, 'KILL');
                await exitsWithin(exited, KILL_WAIT_MS);
            }
        }

        answerAll(CLOSED);
        lines.close();
        stdout.destroy();
    };
    const close = (): Promise<void> => {
        closing ??= runClose();

        return closing;
    };

    const initialized = await call('initialize', {
        clientInfo: { name: CLIENT_NAME, title: null, version: CLIENT_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
    });

    if (initialized.error !== undefined) {
        await close();

        const exit = await exitsWithin(exited, 0) ? await exited : { isMissing: false };

        throw new CodexAppServerError(exit.isMissing ? 'cliMissing' : 'exitedWithError');
    }

    write({ jsonrpc: '2.0', method: 'initialized' });

    return {
        call,
        onNotification: (handler) => {
            handlers.push(handler);
        },
        exited,
        close,
    };
}

export { CodexAppServerError, openCodexAppServer };
export type { CodexAppServer, CodexAppServerOptions, CodexNotificationHandler };
