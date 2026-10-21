import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { IntegrationError } from './integrationFiles.ts';

// One process of an integration. The script comes in on stdin, so it is the exact content that was hashed.
// The secret, when there is one, comes first on stdin as one line, see composeInput. Only its name is kept here.
interface ProcessRequest {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    input: Buffer;
    timeoutMs: number;
    maxOutputBytes: number;
    // The variable the wrapper exports the secret under. Empty or undefined when the integration has no secret.
    secretName: string | undefined;
}

interface ProcessResult {
    exitCode: number | null;
    output: Buffer;
    timedOut: boolean;
    truncated: boolean;
}

interface SpawnOptionsLite {
    cwd: string;
    env: Record<string, string>;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptionsLite) => ChildProcessWithoutNullStreams;

const AGENT_SUDO = '/usr/bin/sudo';
const AGENT_ENV = '/usr/bin/env';
const BASH = '/bin/bash';
const PKILL = '/usr/bin/pkill';
const INTEGRATION_PATH = '/usr/local/bin:/usr/bin:/bin';
const INTEGRATION_HOME = '/var/lib/cloudbot-integrations';
const USER_PATTERN = /^[a-z_][a-z0-9_-]*$/;
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const LINE_BREAKS_PATTERN = /[\r\n\0]/;
// After SIGTERM to sudo, the output is read for this long past the exit, so a held pipe cannot hang the run.
const EXIT_GRACE_MS = 500;
// sudo gets SIGKILL when it has not exited this long after SIGTERM.
const KILL_AFTER_TERM_MS = 2000;
const CLEANUP_TIMEOUT_MS = 30 * 1000;
const CLEANUP_OUTPUT_BYTES = 4096;
// Runs after the kill, as the integration user. It deletes the user's files in its home, /tmp, /var/tmp and /dev/shm,
// and its SysV message queues, semaphores and shared memory. The user name comes in as $1, not in the text.
const WIPE_SCRIPT = [
    'find "$HOME" -mindepth 1 -delete 2>/dev/null',
    'find /tmp /var/tmp /dev/shm -mindepth 1 -user "$1" -delete 2>/dev/null',
    'for kind in q s m; do',
    '  ipcs -"$kind" 2>/dev/null | awk -v u="$1" -v k="$kind" \'$3 == u && $2 ~ /^[0-9]+$/ { print k, $2 }\' | while read -r type id; do',
    '    ipcrm -"$type" "$id" 2>/dev/null',
    '  done',
    'done',
    'exit 0',
].join('\n');

// The fixed bash wrapper. $1 is the process limit. It reads the secret from the first line of stdin, exports it under
// the name in $2, and execs the interpreter in $3 with the rest of the arguments. The script is still on stdin after the
// first line, because bash reads a pipe one byte at a time. Only the name and the interpreter are in argv, never the value.
const INTEGRATION_PROCESS_LIMIT = '256';
const INTEGRATION_WRAPPER = [
    'IFS= read -r KEY_VALUE || exit 1',
    'if [ -n "$2" ]; then export "$2=$KEY_VALUE"; fi',
    'unset KEY_VALUE',
    'PROCESS_LIMIT=$1',
    'COMMAND=$3',
    'shift 3',
    // Bounds a fork bomb and a full disk. If a limit cannot be set, the process does not start.
    // The process limit counts threads of the whole user, and node alone starts about ten.
    'ulimit -u "$PROCESS_LIMIT" || exit 1',
    'ulimit -f 65536 || exit 1',
    'exec "$COMMAND" "$@"',
].join('\n');

// The first line is the secret, then the script. A value with a line break could carry the script away, so it is refused.
function composeInput(secretValue: string | undefined, script: Buffer): Buffer {
    const firstLine = secretValue ?? '';

    if (LINE_BREAKS_PATTERN.test(firstLine)) {
        throw new IntegrationError('That secret has a line break, so it cannot be passed to an integration.');
    }

    const header = Buffer.from(`${firstLine}\n`, 'utf8');

    return Buffer.concat([header, script]);
}

// The sudo line that runs a command as the integration user, with a fixed environment. The user must be a plain name.
function sudoArgs(integrationUser: string, command: string, commandArgs: string[]): string[] {
    if (!USER_PATTERN.test(integrationUser)) {
        throw new Error('Invalid integration user.');
    }

    return [
        '-n',
        '-u',
        integrationUser,
        '--',
        AGENT_ENV,
        '-i',
        `PATH=${INTEGRATION_PATH}`,
        `HOME=${INTEGRATION_HOME}`,
        command,
        ...commandArgs,
    ];
}

// Runs the process as the integration user, a user of its own that cannot read the vault, the workspace or the
// bot's shell. The argv holds the user, the fixed environment, the wrapper, the variable name and the interpreter.
// The value never goes in argv, since argv is readable by every user through ps and /proc.
function asIntegrationUser(integrationUser: string, request: ProcessRequest): ProcessRequest {
    const secretName = request.secretName ?? '';

    if (secretName !== '' && !SECRET_NAME_PATTERN.test(secretName)) {
        throw new Error('Invalid secret name for an integration.');
    }

    const args = sudoArgs(integrationUser, BASH, ['-c', INTEGRATION_WRAPPER, 'cloudbot-integration', INTEGRATION_PROCESS_LIMIT, secretName, request.command, ...request.args]);

    return { ...request, command: AGENT_SUDO, args, cwd: '/', env: { PATH: INTEGRATION_PATH } };
}

interface CleanupRequests {
    kill: ProcessRequest;
    wipe: ProcessRequest;
}

// Two runs after each integration run: kill what the user still runs, then delete its files. The kill runs first, on
// its own, because pkill would also match a shell that runs in the same call.
function buildCleanupRequests(integrationUser: string): CleanupRequests {
    const killArgs = sudoArgs(integrationUser, PKILL, ['-KILL', '-u', integrationUser]);
    const wipeArgs = sudoArgs(integrationUser, BASH, ['-c', WIPE_SCRIPT, 'cloudbot-cleanup', integrationUser]);
    const kill: ProcessRequest = {
        command: AGENT_SUDO,
        args: killArgs,
        cwd: '/',
        env: { PATH: INTEGRATION_PATH },
        input: Buffer.alloc(0),
        timeoutMs: CLEANUP_TIMEOUT_MS,
        maxOutputBytes: CLEANUP_OUTPUT_BYTES,
        secretName: undefined,
    };
    const wipe: ProcessRequest = { ...kill, args: wipeArgs };

    return { kill, wipe };
}

// Runs the process with the given environment only. At the timeout or past the output cap, sudo gets SIGTERM.
// The result is ready once sudo has exited and the output has had a short grace, so a process that kept a pipe open
// cannot hang the run. Its pipes are then closed.
function runIntegrationProcess(request: ProcessRequest, spawnProcess: SpawnProcess = defaultSpawn): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawnProcess(request.command, request.args, { cwd: request.cwd, env: request.env });
        const chunks: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        let truncated = false;
        let exitCode: number | null = null;
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = (): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(killTimer);
            clearTimeout(graceTimer);
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ exitCode, output: Buffer.concat(chunks), timedOut, truncated });
        };
        const stopChild = (): void => {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_TERM_MS);
        };
        const onData = (chunk: Buffer): void => {
            if (truncated) {
                return;
            }

            const room = request.maxOutputBytes - size;

            if (chunk.length > room) {
                const kept = chunk.subarray(0, room);

                chunks.push(kept);
                size = request.maxOutputBytes;
                truncated = true;
                stopChild();

                return;
            }

            chunks.push(chunk);
            size += chunk.length;
        };
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            stopChild();
        }, request.timeoutMs);

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        // The process may exit before it reads its input, which is not an error for the run.
        child.stdin.on('error', () => undefined);
        child.stdin.end(request.input);
        child.on('error', (error) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeoutTimer);
            clearTimeout(killTimer);
            clearTimeout(graceTimer);
            child.stdout.destroy();
            child.stderr.destroy();
            reject(error);
        });
        child.on('exit', (code) => {
            exitCode = code;
            graceTimer = setTimeout(finish, EXIT_GRACE_MS);
        });
        child.on('close', (code) => {
            exitCode = code;
            finish();
        });
    });
}

// Kills and wipes what the integration user left behind. Failures are not thrown, the run has its own result.
async function runCleanup(integrationUser: string): Promise<void> {
    const requests = buildCleanupRequests(integrationUser);

    await runIntegrationProcess(requests.kill)
        .catch(() => undefined);
    await runIntegrationProcess(requests.wipe)
        .catch(() => undefined);
}

function defaultSpawn(command: string, args: string[], options: SpawnOptionsLite): ChildProcessWithoutNullStreams {
    return spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
}

export { INTEGRATION_WRAPPER, asIntegrationUser, buildCleanupRequests, composeInput, runCleanup, runIntegrationProcess };
export type { ProcessRequest, ProcessResult, SpawnProcess };
