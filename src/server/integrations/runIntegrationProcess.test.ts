import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { IntegrationError } from './integrationFiles.ts';
import { INTEGRATION_WRAPPER, asIntegrationUser, buildCleanupRequests, composeInput, runIntegrationProcess } from './runIntegrationProcess.ts';
import type { ProcessRequest, SpawnProcess } from './runIntegrationProcess.ts';

const SECRET_VALUE = 'sk-live-argv-check';
// A script that prints the names of the variables it can see.
const LIST_ENV_SCRIPT = 'console.log(Object.keys(process.env).sort().join(","))';
const IS_WINDOWS = process.platform === 'win32';

function request(script: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
    return {
        command: 'node',
        args: ['-'],
        cwd: process.cwd(),
        env: { PATH: process.env['PATH'] ?? '', HOME: process.cwd() },
        input: Buffer.from(script),
        timeoutMs: 20 * 1000,
        maxOutputBytes: 64 * 1024,
        secretName: undefined,
        ...overrides,
    };
}

interface FakeChild {
    child: ChildProcessWithoutNullStreams;
    stdout: PassThrough;
    signals: string[];
    // Emits the exit, as sudo does when its command ends. The pipes stay open, as a background child keeps them.
    exit: (code: number | null) => void;
}

// A child whose pipes can stay open after it exits. SIGTERM ends it, as sudo relays it to the command.
function fakeChild(): FakeChild {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });
    const signals: string[] = [];
    const emitter = new EventEmitter();
    const exit = (code: number | null): void => {
        emitter.emit('exit', code);
    };
    const child = Object.assign(emitter, {
        stdout,
        stderr,
        stdin,
        kill: (signal: string) => {
            signals.push(signal);

            if (signal === 'SIGTERM') {
                setImmediate(() => emitter.emit('exit', null));
            }

            return true;
        },
    });

    return { child: child as unknown as ChildProcessWithoutNullStreams, stdout, signals, exit };
}

describe('runIntegrationProcess', () => {
    it('gives the child only the variables it was passed, never the server environment', async () => {
        process.env['CLOUDBOT_TEST_PARENT_SECRET'] = 'parent-value';

        try {
            const result = await runIntegrationProcess(request(LIST_ENV_SCRIPT, {
                env: { PATH: process.env['PATH'] ?? '', HOME: process.cwd() },
            }));
            const names = result.output.toString('utf8')
                .trim()
                .split(',');

            expect(names)
                .not.toContain('CLOUDBOT_TEST_PARENT_SECRET');
        } finally {
            delete process.env['CLOUDBOT_TEST_PARENT_SECRET'];
        }
    });

    it('reads the script from stdin and reports the exit code', async () => {
        const result = await runIntegrationProcess(request('console.log("hello"); process.exit(3)'));

        expect(result.output.toString('utf8')
            .trim())
            .toBe('hello');
        expect(result.exitCode)
            .toBe(3);
        expect(result.timedOut)
            .toBe(false);
    });

    it('stops a process at the timeout', async () => {
        const result = await runIntegrationProcess(request('setTimeout(() => {}, 60000)', { timeoutMs: 300 }));

        expect(result.timedOut)
            .toBe(true);
    });

    it('stops a process past the output cap and says the output was cut', async () => {
        const result = await runIntegrationProcess(request('setInterval(() => console.log("x".repeat(1000)), 1)', { maxOutputBytes: 4096 }));

        expect(result.truncated)
            .toBe(true);
        expect(result.output.length)
            .toBeLessThanOrEqual(4096);
    });

    it('resolves after sudo exits even when a background child keeps the output pipe open', async () => {
        const fake = fakeChild();
        const spawnProcess: SpawnProcess = () => fake.child;
        const pending = runIntegrationProcess(request(''), spawnProcess);

        fake.stdout.write('partial output');
        fake.exit(0);

        const result = await pending;

        expect(result.exitCode)
            .toBe(0);
        expect(result.output.toString('utf8'))
            .toBe('partial output');
    });

    it('sends SIGTERM at the timeout and resolves once sudo has exited', async () => {
        const fake = fakeChild();
        const spawnProcess: SpawnProcess = () => fake.child;
        const result = await runIntegrationProcess(request('', { timeoutMs: 20 }), spawnProcess);

        expect(result.timedOut)
            .toBe(true);
        expect(fake.signals)
            .toEqual(['SIGTERM']);
    });

    it.skipIf(IS_WINDOWS)('the wrapper exports the secret from the first stdin line, under the name it is given', async () => {
        const script = 'console.log(process.env.STORE_API_KEY)';
        const result = await runIntegrationProcess(request('', {
            command: 'bash',
            args: ['-c', INTEGRATION_WRAPPER, 'cloudbot-integration', 'unlimited', 'STORE_API_KEY', 'node', '-'],
            env: { PATH: process.env['PATH'] ?? '' },
            input: composeInput(SECRET_VALUE, Buffer.from(script)),
        }));

        expect(result.output.toString('utf8')
            .trim())
            .toBe(SECRET_VALUE);
    });

    it.skipIf(IS_WINDOWS)('the wrapper caps the process count and the file size before it runs the command', async () => {
        const result = await runIntegrationProcess(request('', {
            command: 'bash',
            args: ['-c', INTEGRATION_WRAPPER, 'cloudbot-integration', '64', '', 'bash', '-c', 'ulimit -u; ulimit -f'],
            env: { PATH: process.env['PATH'] ?? '' },
            input: composeInput(undefined, Buffer.alloc(0)),
        }));

        expect(result.output.toString('utf8')
            .trim()
            .split('\n'))
            .toEqual(['64', '65536']);
    });

    it('never puts the secret value in the argv of the sudo command', () => {
        const input = composeInput(SECRET_VALUE, Buffer.from(LIST_ENV_SCRIPT));
        const wrapped = asIntegrationUser('cloudbot-integrations', request(LIST_ENV_SCRIPT, { input, secretName: 'STORE_API_KEY' }));

        expect(JSON.stringify(wrapped.args))
            .not.toContain(SECRET_VALUE);
        expect(wrapped.command)
            .toBe('/usr/bin/sudo');
        expect(wrapped.args.slice(0, 4))
            .toEqual(['-n', '-u', 'cloudbot-integrations', '--']);
        expect(wrapped.args)
            .toContain('STORE_API_KEY');
        expect(wrapped.cwd)
            .toBe('/');
        expect(wrapped.env)
            .toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin' });
    });

    it('never puts the secret value in the argv of the cleanup commands, and names the user from its argument', () => {
        const requests = buildCleanupRequests('cloudbot-integrations');
        const all = [...requests.kill.args, ...requests.wipe.args];

        expect(JSON.stringify(all))
            .not.toContain(SECRET_VALUE);
        expect(requests.kill.args)
            .toContain('/usr/bin/pkill');
        expect(requests.kill.args)
            .toContain('-KILL');
        expect(requests.wipe.args)
            .toContain('cloudbot-cleanup');
        expect(requests.wipe.args.slice(-1))
            .toEqual(['cloudbot-integrations']);
    });

    it('refuses a user name or a variable name that could change the command', () => {
        expect(() => asIntegrationUser('root; rm', request(LIST_ENV_SCRIPT)))
            .toThrow('Invalid integration user.');
        expect(() => asIntegrationUser('cloudbot-integrations', request(LIST_ENV_SCRIPT, { secretName: 'A=B' })))
            .toThrow('Invalid secret name');
        expect(() => buildCleanupRequests('root; rm'))
            .toThrow('Invalid integration user.');
    });

    it('refuses a secret with a line break, so it cannot carry the script away', () => {
        expect(() => composeInput('first\nsecond', Buffer.from('x')))
            .toThrow(IntegrationError);
    });
});
