import { INTEGRATION_COMMANDS } from '../../shared/integrations.ts';
import type { IntegrationCommand } from '../../shared/integrations.ts';
import type { BotSecret, BotSecrets } from '../secrets/BotSecrets.ts';
import { assertSecretName } from '../secrets/BotSecrets.ts';
import type { IntegrationRecord, IntegrationStore } from '../store/IntegrationStore.ts';
import { IntegrationError, hashContent, readEntryFile } from './integrationFiles.ts';
import { redactSecret } from './redactSecret.ts';
import { composeInput } from './runIntegrationProcess.ts';
import type { ProcessRequest, ProcessResult } from './runIntegrationProcess.ts';

interface IntegrationServiceDeps {
    store: IntegrationStore;
    secrets: Pick<BotSecrets, 'read'>;
    workspaceFor: (botId: string) => string;
    run: (request: ProcessRequest) => Promise<ProcessResult>;
    // Kills and wipes what the integration user left. Called before and after each run.
    cleanup: () => Promise<void>;
    now?: (() => number) | undefined;
}

interface RegisterInput {
    name: string;
    entryPath: string;
    command: IntegrationCommand;
    secretName: string | undefined;
    // The sha256 of the entry file the owner approves, computed by the bot. The file must still have this hash.
    sha256: string;
}

// The input of integration_create and integration_update. For an update, a field that is not given keeps the stored value.
interface ChangeInput {
    name: string;
    entryPath: string | undefined;
    command: string | undefined;
    // Undefined keeps the secret, null or an empty string removes it, and a name sets it.
    secretName: string | null | undefined;
    sha256: string;
}

// The mode of a card. A create must not name an integration that exists, and an update must name one.
type ChangeMode = 'create' | 'update';

interface ChangeCardReady {
    ok: true;
    text: string;
}

interface ChangeCardRefused {
    ok: false;
    reason: string;
}

type ChangeCard = ChangeCardReady | ChangeCardRefused;

interface ResolvedChange {
    name: string;
    entryPath: string;
    command: IntegrationCommand;
    secretName: string | undefined;
    sha256: string;
}

interface IntegrationLastRun {
    startedAt: number;
    exitCode: number | null;
    timedOut: boolean;
}

interface IntegrationSummary {
    name: string;
    entryPath: string;
    command: IntegrationCommand;
    secretName: string | undefined;
    lastRun: IntegrationLastRun | undefined;
}

interface RunOutcome {
    exitCode: number | null;
    timedOut: boolean;
    truncated: boolean;
    output: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const NAME_RULE = 'Use 2 to 31 lowercase letters, digits and hyphens, starting with a letter.';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_INTEGRATIONS_PER_BOT = 10;
const RUN_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULT_CHARS = 4000;
const MAX_LOG_CHARS = 2000;
// The whole script is on the approval card, so it must fit there. Bytes are at least as many as characters.
const MAX_SCRIPT_BYTES = 8000;
const CHANGED_MESSAGE = 'The entry file changed since it was last registered, so it was not run. The owner must approve the new version: call integration_update with the same name and the new sha256.';
const MISMATCH_MESSAGE = 'The entry file does not match the sha256 in the request. Compute the sha256 of the current file with sha256sum and try again.';
const CHECK_FAILED_MESSAGE = 'The integration could not be checked.';
// Names the process environment uses, or that make the interpreter load code or change its behavior.
const RESERVED_SECRET_NAMES = new Set([
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP',
    'PYTHONPATH', 'PYTHONHOME', 'PATH', 'HOME', 'IFS', 'PS4', 'SHELLOPTS', 'BASHOPTS',
]);
// Each interpreter reads its script from stdin, so the script is the exact content that was hashed.
const COMMAND_ARGS: Record<IntegrationCommand, string[]> = {
    node: ['-'],
    python3: ['-'],
    bash: ['-s'],
};
const ignore = (): void => undefined;

function isReservedSecretName(name: string): boolean {
    return RESERVED_SECRET_NAMES.has(name) || name.startsWith('LD_') || name.startsWith('BASH_FUNC');
}

function isIntegrationCommand(value: string | undefined): value is IntegrationCommand {
    return INTEGRATION_COMMANDS.some(command => command === value);
}

// Control characters other than tab and line feed, C1 controls, zero-width and invisible format characters, bidi
// overrides and isolates, line and paragraph separators, the byte order mark, and the language tag block. A carriage
// return is a line end in JavaScript and Python, so it is refused too: a `//` comment would end where the card shows it.
function isHiddenCode(code: number): boolean {
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a;
    const isDelete = code >= 0x7f && code <= 0x9f;
    const isSoftHyphen = code === 0x00ad;
    const isArabicLetterMark = code === 0x061c;
    const isZeroWidth = code >= 0x200b && code <= 0x200f;
    const isBidi = code >= 0x202a && code <= 0x202e;
    const isIsolate = code >= 0x2066 && code <= 0x2069;
    const isLineSeparator = code === 0x2028 || code === 0x2029;
    const isWordJoiner = code >= 0x2060 && code <= 0x2064;
    const isTag = code >= 0xe0000 && code <= 0xe007f;

    return isControl || isDelete || isSoftHyphen || isArabicLetterMark || isZeroWidth || isBidi || isIsolate
        || isLineSeparator || isWordJoiner || isTag || code === 0xfeff;
}

// Refuses a script that is too large for the card, or that has characters which could hide its content.
function checkScript(content: Buffer): void {
    if (content.length > MAX_SCRIPT_BYTES) {
        throw new IntegrationError(`The script is larger than ${String(MAX_SCRIPT_BYTES)} bytes. Keep the script short.`);
    }

    const text = content.toString('utf8');

    if (text.includes('\r')) {
        throw new IntegrationError('The script has a carriage return. Save the script with LF line endings and register again.');
    }

    const hasHidden = Array.from(text)
        .some((character) => {
            const code = character.codePointAt(0) ?? 0;

            return isHiddenCode(code);
        });

    if (hasHidden) {
        throw new IntegrationError('The script has a control, bidi or zero-width character, which could hide what it does. Remove it and register again.');
    }
}

function messageOf(error: unknown): string {
    return error instanceof IntegrationError ? error.message : CHECK_FAILED_MESSAGE;
}

// Reads one text field of the tool input. The input comes from the model, so anything else is read as missing.
function readOptionalText(input: unknown, key: string): string | undefined {
    if (typeof input !== 'object' || input === null) {
        return undefined;
    }

    const value: unknown = Reflect.get(input, key);

    return typeof value === 'string' ? value.trim() : undefined;
}

function readChangeInput(input: unknown): ChangeInput {
    const name = readOptionalText(input, 'name') ?? '';
    const rawEntryPath = readOptionalText(input, 'entryPath');
    const entryPath = rawEntryPath === '' ? undefined : rawEntryPath;
    const rawCommand = readOptionalText(input, 'command');
    const command = rawCommand === '' ? undefined : rawCommand;
    const rawSecret: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'secretName') : undefined;
    const secretName = rawSecret === null ? null : readOptionalText(input, 'secretName');
    const sha256 = (readOptionalText(input, 'sha256') ?? '').toLowerCase();

    return { name, entryPath, command, secretName, sha256 };
}

// The secret an update leaves in place: kept when it was not given, removed when it was empty or null.
function resolveSecretName(requested: string | null | undefined, current: string | null): string | undefined {
    if (requested === undefined) {
        return current ?? undefined;
    }

    if (requested === null || requested === '') {
        return undefined;
    }

    return requested;
}

// The change that would be saved: the input over the stored record, the same way for the card and for the update.
function mergeChange(record: IntegrationRecord | undefined, input: ChangeInput): ResolvedChange {
    const entryPath = input.entryPath ?? record?.entryPath;

    if (entryPath === undefined) {
        throw new IntegrationError('Give the path of the entry file, inside the workspace.');
    }

    const command = input.command ?? record?.command;

    if (!isIntegrationCommand(command)) {
        throw new IntegrationError('The command must be node, python3 or bash.');
    }

    const secretName = resolveSecretName(input.secretName, record?.secretName ?? null);

    return { name: input.name, entryPath, command, secretName, sha256: input.sha256 };
}

// Registers scripts the bot wrote as integrations, and runs them with one secret in their environment.
// Runs go one at a time, since every run of an integration shares one user.
class IntegrationService {
    private readonly deps: IntegrationServiceDeps;
    private queue: Promise<void> = Promise.resolve();

    constructor(deps: IntegrationServiceDeps) {
        this.deps = deps;
    }

    async register(botId: string, input: RegisterInput): Promise<IntegrationSummary> {
        if (!NAME_PATTERN.test(input.name)) {
            throw new IntegrationError(`That integration name is not valid. ${NAME_RULE}`);
        }

        const existing = await this.deps.store.findByName(botId, input.name);

        if (existing !== undefined) {
            throw new IntegrationError('An integration with that name already exists. Use integration_update to change it.');
        }

        const all = await this.deps.store.list(botId);

        if (all.length >= MAX_INTEGRATIONS_PER_BOT) {
            throw new IntegrationError(`The bot can keep at most ${String(MAX_INTEGRATIONS_PER_BOT)} integrations. Remove one first.`);
        }

        this.checkNewSecret(botId, input.secretName);
        const entryHash = await this.checkedHash(botId, input.entryPath, input.sha256);
        const record = await this.deps.store.add(botId, {
            name: input.name,
            entryPath: input.entryPath,
            command: input.command,
            secretName: input.secretName,
            entryHash,
        });

        return this.summarize(record);
    }

    async update(botId: string, input: ChangeInput): Promise<IntegrationSummary> {
        const record = await this.require(botId, input.name);

        this.checkNewSecret(botId, input.secretName ?? undefined);

        const resolved = mergeChange(record, input);
        // The file is checked again here. This is the version the owner approves, and the next run uses its hash.
        const entryHash = await this.checkedHash(botId, resolved.entryPath, input.sha256);

        await this.deps.store.update(record.id, {
            entryPath: resolved.entryPath,
            command: resolved.command,
            secretName: resolved.secretName,
            entryHash,
        });

        const updated = await this.require(botId, input.name);

        return this.summarize(updated);
    }

    async list(botId: string): Promise<IntegrationSummary[]> {
        const records = await this.deps.store.list(botId);

        const summaries = records.map(record => this.summarize(record));

        return Promise.all(summaries);
    }

    async remove(botId: string, name: string): Promise<void> {
        const record = await this.require(botId, name);

        await this.deps.store.remove(record.id);
    }

    // The approval card for a create or an update. It shows the values the change would save, and the whole script.
    // A change that cannot be shown whole, or whose file does not match, is refused instead of shown.
    async describeChange(botId: string, mode: ChangeMode, input: unknown): Promise<ChangeCard> {
        const change = readChangeInput(input);
        let resolved: ResolvedChange;

        try {
            const record = mode === 'update' ? await this.require(botId, change.name) : undefined;

            resolved = mergeChange(record, change);
            this.checkNewSecret(botId, resolved.secretName);
        } catch (error: unknown) {
            return { ok: false, reason: messageOf(error) };
        }

        if (!SHA256_PATTERN.test(resolved.sha256)) {
            return { ok: false, reason: 'The sha256 must be the 64 hex characters of the entry file, computed with sha256sum.' };
        }

        const workspaceDir = this.deps.workspaceFor(botId);
        let content: Buffer;

        try {
            content = await readEntryFile(workspaceDir, resolved.entryPath);
        } catch (error: unknown) {
            return { ok: false, reason: `The script could not be read. ${messageOf(error)}` };
        }

        const actual = hashContent(content);

        if (actual !== resolved.sha256) {
            return { ok: false, reason: `The file does not match the sha256 in the request. The file on disk has ${actual}.` };
        }

        try {
            checkScript(content);
        } catch (error: unknown) {
            return { ok: false, reason: messageOf(error) };
        }

        const script = content.toString('utf8');
        const secretLine = this.describeSecret(botId, resolved.secretName ?? '');
        const header = [
            `Name: ${JSON.stringify(resolved.name)}`,
            `Entry file: ${JSON.stringify(resolved.entryPath)}`,
            `Command: ${resolved.command}`,
            `Secret: ${secretLine}`,
            `sha256: ${resolved.sha256}`,
            'Script:',
        ];

        return { ok: true, text: [...header, script].join('\n') };
    }

    // Runs the integration. The file must still be the one that was registered, and the secret is redacted from the output.
    async run(botId: string, name: string): Promise<RunOutcome> {
        const record = await this.require(botId, name);
        const workspaceDir = this.deps.workspaceFor(botId);
        const content = await readEntryFile(workspaceDir, record.entryPath);

        checkScript(content);

        if (hashContent(content) !== record.entryHash) {
            throw new IntegrationError(CHANGED_MESSAGE);
        }

        const secret = this.readSecret(botId, record);
        const input = composeInput(secret?.value, content);
        const request: ProcessRequest = {
            command: record.command,
            args: COMMAND_ARGS[record.command],
            cwd: workspaceDir,
            env: {},
            input,
            timeoutMs: RUN_TIMEOUT_MS,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            secretName: record.secretName ?? undefined,
        };
        const startedAt = this.now();
        const result = await this.exclusive(() => this.runAndClean(request));
        // The secret is removed from the whole output, then the cut is applied. A secret split by a cut is dropped.
        const outputText = result.output.toString('utf8');
        const redacted = redactSecret(outputText, secret?.value, result.truncated || result.timedOut);

        await this.deps.store.addRun(record.id, {
            startedAt,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            output: redacted.slice(0, MAX_LOG_CHARS),
        });

        return {
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            output: redacted.slice(0, MAX_RESULT_CHARS),
        };
    }

    private now(): number {
        return this.deps.now === undefined ? Date.now() : this.deps.now();
    }

    // Queues the task behind the runs before it. A failed run does not block the next one.
    private exclusive<T>(task: () => Promise<T>): Promise<T> {
        const running = this.queue.then(task);

        this.queue = running.then(ignore, ignore);

        return running;
    }

    // The user's leftovers are cleared before the run, so one run cannot start on another's processes or files.
    private async runAndClean(request: ProcessRequest): Promise<ProcessResult> {
        await this.cleanupUser();

        try {
            return await this.startRun(request);
        } finally {
            await this.cleanupUser();
        }
    }

    private async cleanupUser(): Promise<void> {
        try {
            await this.deps.cleanup();
        } catch {
            console.error('Could not clean up after an integration run.');
        }
    }

    private async require(botId: string, name: string): Promise<IntegrationRecord> {
        const record = await this.deps.store.findByName(botId, name);

        if (record === undefined) {
            throw new IntegrationError(`There is no integration named "${name}".`);
        }

        return record;
    }

    // The entry file must have the hash the bot sent, which is the hash the owner approved.
    private async checkedHash(botId: string, entryPath: string, sha256: string): Promise<string> {
        const expected = sha256.trim()
            .toLowerCase();

        if (!SHA256_PATTERN.test(expected)) {
            throw new IntegrationError('The sha256 must be the 64 hex characters of the entry file, computed with sha256sum.');
        }

        const workspaceDir = this.deps.workspaceFor(botId);
        const content = await readEntryFile(workspaceDir, entryPath);

        checkScript(content);

        if (hashContent(content) !== expected) {
            throw new IntegrationError(MISMATCH_MESSAGE);
        }

        return expected;
    }

    // Undefined and an empty name pass, since they keep or remove the secret. A name must be valid and saved.
    private checkNewSecret(botId: string, secretName: string | undefined): void {
        if (secretName === undefined || secretName === '') {
            return;
        }

        this.checkSecretName(secretName);
        this.checkSecretSaved(botId, secretName);
    }

    private checkSecretName(secretName: string): void {
        try {
            assertSecretName(secretName);
        } catch (error: unknown) {
            throw new IntegrationError(error instanceof Error ? error.message : 'That secret name is not valid.');
        }

        if (isReservedSecretName(secretName)) {
            throw new IntegrationError('That name is used by the process environment or changes how a script runs. Pick another secret name.');
        }
    }

    private checkSecretSaved(botId: string, secretName: string): void {
        if (this.deps.secrets.read(botId, secretName) === undefined) {
            throw new IntegrationError('That secret is not saved yet. Ask the owner to fill in the secure form first.');
        }
    }

    private describeSecret(botId: string, secretName: string): string {
        if (secretName === '') {
            return 'none';
        }

        const secret = this.deps.secrets.read(botId, secretName);

        return secret === undefined ? `${secretName}, not saved yet` : `${secretName}, for ${secret.site}`;
    }

    private readSecret(botId: string, record: IntegrationRecord): BotSecret | undefined {
        if (record.secretName === null) {
            return undefined;
        }

        const secret = this.deps.secrets.read(botId, record.secretName);

        if (secret === undefined) {
            throw new IntegrationError('That secret is not saved any more. Ask the owner to fill in the secure form again.');
        }

        return secret;
    }

    private async startRun(request: ProcessRequest): Promise<ProcessResult> {
        try {
            return await this.deps.run(request);
        } catch {
            throw new IntegrationError('The integration could not be started.');
        }
    }

    private async summarize(record: IntegrationRecord): Promise<IntegrationSummary> {
        const runs = await this.deps.store.listRuns(record.id);
        const lastRun = runs[0];

        return {
            name: record.name,
            entryPath: record.entryPath,
            command: record.command,
            secretName: record.secretName ?? undefined,
            lastRun: lastRun === undefined ? undefined : { startedAt: lastRun.startedAt, exitCode: lastRun.exitCode, timedOut: lastRun.timedOut },
        };
    }
}

export { IntegrationService, MAX_INTEGRATIONS_PER_BOT, MAX_SCRIPT_BYTES, NAME_PATTERN, RUN_TIMEOUT_MS, MAX_OUTPUT_BYTES };
export type { ChangeCard, ChangeInput, ChangeMode, IntegrationLastRun, IntegrationServiceDeps, IntegrationSummary, RegisterInput, RunOutcome };
