import { execFile } from 'node:child_process';

import { DEFAULT_BITWARDEN_SERVER_URL } from '../../shared/bitwarden.ts';

// The owner's Bitwarden sign-in, as the server keeps it in the vault.
interface BitwardenAccount {
    serverUrl: string;
    clientId: string;
    clientSecret: string;
    masterPassword: string;
}

// One login item of the vault. The list never holds a password, a user name or a code.
interface BitwardenLoginItem {
    id: string;
    name: string;
    uris: string[];
    hasTotp: boolean;
}

type BitwardenField = 'username' | 'password' | 'totp';

interface BitwardenRunRequest {
    args: string[];
    // The whole environment of the process. Secrets travel here, never in the arguments, since argv shows in ps.
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes: number;
}

// Runs the bw command and answers with its standard output. It throws BitwardenRunError on a failure.
type BitwardenRunner = (request: BitwardenRunRequest) => Promise<string>;

type BitwardenRunFailure = 'failed' | 'timeout' | 'too_big';

class BitwardenRunError extends Error {
    readonly failure: BitwardenRunFailure;
    // What the command wrote to its error output. The caller masks it before it shows any of it.
    readonly detail: string;

    constructor(failure: BitwardenRunFailure, detail: string) {
        super(`The bw command ended with: ${failure}.`);
        this.name = 'BitwardenRunError';
        this.failure = failure;
        this.detail = detail;
    }
}

const FAILURE_NOTES: Record<BitwardenRunFailure, string> = {
    failed: '',
    timeout: ' It took too long.',
    too_big: ' The answer was too big.',
};

// The message is written for the owner and the model. It never holds a secret.
class BitwardenError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BitwardenError';
    }
}

interface BitwardenCliOptions {
    account: BitwardenAccount;
    // A folder only the server user can read. bw keeps its sign-in state there.
    appDataDir: string;
    runner?: BitwardenRunner;
    command?: string;
    idleLockMs?: number;
    timeoutMs?: number;
}

const BW_COMMAND = 'bw';
const IDLE_LOCK_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 60_000;
// A vault list holds every login, so it gets more room than a single value.
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 200;
const MASKED_SECRET = '***';
const SESSION_KEY_PATTERN = /^\S{16,}$/;

// The environment bw gets. It does not inherit the server's variables, so no unrelated secret reaches the child.
function buildBaseEnv(appDataDir: string): Record<string, string> {
    const pathValue = process.env.PATH ?? '';

    return {
        PATH: pathValue,
        HOME: appDataDir,
        BITWARDENCLI_APPDATA_DIR: appDataDir,
        BW_NOINTERACTION: 'true',
        NODE_NO_WARNINGS: '1',
    };
}

function defaultRunner(command: string): BitwardenRunner {
    return request => new Promise((resolve, reject) => {
        const options = {
            env: request.env,
            timeout: request.timeoutMs,
            maxBuffer: request.maxOutputBytes,
            windowsHide: true,
            encoding: 'utf8' as const,
        };

        execFile(command, request.args, options, (error, stdout, stderr) => {
            if (error === null) {
                resolve(stdout);

                return;
            }

            if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                reject(new BitwardenRunError('too_big', ''));

                return;
            }

            // A command that outlives the timeout is killed by execFile.
            const failure: BitwardenRunFailure = error.killed === true ? 'timeout' : 'failed';

            reject(new BitwardenRunError(failure, stderr));
        });
    });
}

function readServerUrl(statusText: string): string {
    try {
        const parsed: unknown = JSON.parse(statusText);
        const serverUrl: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'serverUrl') : undefined;

        return typeof serverUrl === 'string' ? serverUrl.replace(/\/+$/, '') : DEFAULT_BITWARDEN_SERVER_URL;
    } catch {
        return '';
    }
}

function readStatusName(statusText: string): string {
    try {
        const parsed: unknown = JSON.parse(statusText);
        const status: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'status') : undefined;

        return typeof status === 'string' ? status : '';
    } catch {
        return '';
    }
}

function readStringProperty(source: object, key: string): string | undefined {
    const value: unknown = Reflect.get(source, key);

    return typeof value === 'string' ? value : undefined;
}

function readLoginItem(raw: unknown): BitwardenLoginItem | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }

    const id = readStringProperty(raw, 'id');
    const name = readStringProperty(raw, 'name');
    const login: unknown = Reflect.get(raw, 'login');

    // Type 1 is a login. Cards, notes and identities have no login object.
    if (id === undefined || name === undefined || Reflect.get(raw, 'type') !== 1 || typeof login !== 'object' || login === null) {
        return undefined;
    }

    const rawUris: unknown = Reflect.get(login, 'uris');
    const uriObjects = Array.isArray(rawUris) ? rawUris as unknown[] : [];
    const uris = uriObjects.flatMap((uriObject) => {
        const uri = typeof uriObject === 'object' && uriObject !== null ? readStringProperty(uriObject, 'uri') : undefined;

        return uri === undefined || uri === '' ? [] : [uri];
    });
    const totp = readStringProperty(login, 'totp');

    return { id, name, uris, hasTotp: totp !== undefined && totp !== '' };
}

// Runs the official Bitwarden CLI for one account. Only the server process starts it, never the bot's shell.
// Every secret goes in the environment of the child, and the unlocked session key stays in this object's memory.
class BitwardenCli {
    private readonly account: BitwardenAccount;
    private readonly baseEnv: Record<string, string>;
    private readonly runner: BitwardenRunner;
    private readonly idleLockMs: number;
    private readonly timeoutMs: number;
    private sessionKey: string | undefined;
    private idleTimer: NodeJS.Timeout | undefined;
    // The commands run one at a time, since bw keeps one sign-in state in its folder.
    private queue: Promise<unknown> = Promise.resolve();

    constructor(options: BitwardenCliOptions) {
        this.account = options.account;
        this.baseEnv = buildBaseEnv(options.appDataDir);
        this.runner = options.runner ?? defaultRunner(options.command ?? BW_COMMAND);
        this.idleLockMs = options.idleLockMs ?? IDLE_LOCK_MS;
        this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    }

    // Signs in, unlocks and syncs. It is the connection test, and every other call starts with it.
    async unlock(): Promise<void> {
        await this.exclusive(() => this.ensureUnlocked());
    }

    async listLogins(): Promise<BitwardenLoginItem[]> {
        return this.exclusive(async () => {
            await this.ensureUnlocked();

            const output = await this.run(['list', 'items'], {}, 'The Bitwarden items could not be listed.', true);
            let parsed: unknown;

            try {
                parsed = JSON.parse(output);
            } catch {
                throw new BitwardenError('Bitwarden answered with something that is not a list of items.');
            }

            const rawItems = Array.isArray(parsed) ? parsed as unknown[] : [];

            return rawItems.flatMap((rawItem) => {
                const item = readLoginItem(rawItem);

                return item === undefined ? [] : [item];
            });
        });
    }

    async getValue(itemId: string, field: BitwardenField): Promise<string> {
        return this.exclusive(async () => {
            await this.ensureUnlocked();

            const output = await this.run(['get', field, itemId], {}, `The ${field} could not be read from Bitwarden.`, true);
            // bw ends the value with a line break only in a terminal. A trailing one is not part of the value.
            const value = output.replace(/\r?\n$/, '');

            if (value === '') {
                throw new BitwardenError(`That login has no ${field}.`);
            }

            return value;
        });
    }

    // Locks the vault and forgets the session key. A lock that fails still drops the key from memory.
    async lock(): Promise<void> {
        await this.exclusive(() => this.lockNow());
    }

    // Signs out and forgets the key, so no sign-in stays in the folder of bw.
    async logout(): Promise<void> {
        await this.exclusive(async () => {
            this.clearIdleTimer();
            this.sessionKey = undefined;

            try {
                await this.run(['logout'], {}, 'Bitwarden could not sign out.', false);
            } catch {
                // Signed out already, or never signed in. The folder is removed by the caller.
            }
        });
    }

    private exclusive<T>(action: () => Promise<T>): Promise<T> {
        const next = this.queue.then(action);

        this.queue = next.catch(() => undefined);

        return next;
    }

    private async lockNow(): Promise<void> {
        this.clearIdleTimer();
        this.sessionKey = undefined;

        try {
            await this.run(['lock'], {}, 'Bitwarden could not lock.', false);
        } catch {
            // The key is already gone from memory, and the next call unlocks again.
        }
    }

    private clearIdleTimer(): void {
        if (this.idleTimer !== undefined) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    // Each use pushes the lock further away, so the vault locks 10 minutes after the last use.
    private armIdleTimer(): void {
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.lock()
                .catch(() => undefined);
        }, this.idleLockMs);
        this.idleTimer.unref();
    }

    private async ensureUnlocked(): Promise<void> {
        if (this.sessionKey !== undefined) {
            this.armIdleTimer();

            return;
        }

        await this.signIn();

        const unlockEnv = { BW_PASSWORD: this.account.masterPassword };
        const rawKey = await this.run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], unlockEnv, 'Bitwarden did not unlock. Check the master password.', false);
        const sessionKey = rawKey.trim();

        if (!SESSION_KEY_PATTERN.test(sessionKey)) {
            throw new BitwardenError('Bitwarden did not give a session. Check the master password.');
        }

        this.sessionKey = sessionKey;
        this.armIdleTimer();

        try {
            await this.run(['sync'], {}, 'Bitwarden could not sync.', true);
        } catch (error: unknown) {
            await this.lockNow();

            throw error;
        }
    }

    // Logs in with the API key when the folder holds no sign-in, or one for another server.
    private async signIn(): Promise<void> {
        const statusText = await this.run(['status'], {}, 'Bitwarden did not answer.', false);
        const statusName = readStatusName(statusText);
        const configuredUrl = this.account.serverUrl.replace(/\/+$/, '');

        if (statusName !== '' && statusName !== 'unauthenticated') {
            if (readServerUrl(statusText) === configuredUrl) {
                return;
            }

            await this.run(['logout'], {}, 'Bitwarden could not sign out.', false);
        }

        await this.run(['config', 'server', configuredUrl], {}, 'The Bitwarden server address was refused.', false);

        const loginEnv = { BW_CLIENTID: this.account.clientId, BW_CLIENTSECRET: this.account.clientSecret };

        await this.run(['login', '--apikey'], loginEnv, 'Bitwarden refused the API key. Check the client ID and the client secret.', false);
    }

    // Starts one command. A failure becomes a plain sentence, plus the first line of the error with every secret masked.
    private async run(args: string[], extraEnv: Record<string, string>, failureMessage: string, needsSession: boolean): Promise<string> {
        const sessionEnv = needsSession && this.sessionKey !== undefined ? { BW_SESSION: this.sessionKey } : {};
        const env = { ...this.baseEnv, ...sessionEnv, ...extraEnv };

        try {
            return await this.runner({ args, env, timeoutMs: this.timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
        } catch (error: unknown) {
            const note = error instanceof BitwardenRunError ? FAILURE_NOTES[error.failure] : '';
            const detail = error instanceof BitwardenRunError ? this.describeDetail(error.detail) : '';

            throw new BitwardenError(`${failureMessage}${note}${detail}`);
        }
    }

    private describeDetail(rawDetail: string): string {
        const firstLine = rawDetail.split('\n')[0]
            ?.trim() ?? '';

        if (firstLine === '') {
            return '';
        }

        const secrets = [this.account.masterPassword, this.account.clientSecret, this.account.clientId, this.sessionKey ?? ''];
        const masked = secrets.filter(secret => secret.length > 0)
            .reduce((text, secret) => text.split(secret)
                .join(MASKED_SECRET), firstLine);

        return ` Bitwarden said: ${masked.slice(0, MAX_ERROR_DETAIL_LENGTH)}`;
    }
}

export { BitwardenCli, BitwardenError, BitwardenRunError, IDLE_LOCK_MS, MAX_OUTPUT_BYTES };
export type { BitwardenAccount, BitwardenCliOptions, BitwardenField, BitwardenLoginItem, BitwardenRunFailure, BitwardenRunner, BitwardenRunRequest };
