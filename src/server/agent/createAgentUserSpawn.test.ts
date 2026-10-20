import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildAgentEnvironment, createAgentUserSpawn } from './createAgentUserSpawn.ts';

const CLI_PATH = '/home/bot/.local/bin/claude';

interface FakeProcess extends EventEmitter {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    exitCode: null;
    kill: () => boolean;
}

function fakeProcess(): FakeProcess {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        exitCode: null,
        kill: () => true,
    });
}

function sdkSpawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
    return {
        command: CLI_PATH,
        args: ['--print', '--input-format', 'stream-json', 'literal; $(id)'],
        cwd: '/var/lib/cloudbot-workspaces/bot-1',
        env: { SERVER_SECRET: 'private', ANTHROPIC_API_KEY: 'real-key', NODE_OPTIONS: '--inspect' },
        signal: new AbortController().signal,
        ...overrides,
    };
}

describe('createAgentUserSpawn', () => {
    it('drains stderr without logging it and retains only the last 4096 bytes', () => {
        const child = fakeProcess();
        const onStderrTail = vi.fn();
        const log = vi.spyOn(console, 'error');
        const spawnAgent = createAgentUserSpawn({ user: 'bot', executable: CLI_PATH, spawnFunction: () => child, onStderrTail });

        spawnAgent(sdkSpawnOptions());
        child.stderr.write('https://fake.example/setup?code=untrusted\n');
        child.stderr.write('x'.repeat(8192));
        child.stderr.write('failure');
        expect(onStderrTail)
            .toHaveBeenLastCalledWith(`${'x'.repeat(4089)}failure`);
        expect(log)
            .not.toHaveBeenCalled();
        expect(child.stderr.readableLength)
            .toBe(0);
    });

    it('runs only the configured CLI through sudo with literal arguments and the SDK signal', () => {
        const child = fakeProcess();
        const spawnFunction = vi.fn(() => child);
        const spawnAgent = createAgentUserSpawn({ user: 'bot', executable: CLI_PATH, spawnFunction });
        const options = sdkSpawnOptions();
        const result = spawnAgent(options);

        expect(result)
            .toBe(child);
        expect(spawnFunction)
            .toHaveBeenCalledExactlyOnceWith('/usr/bin/sudo', [
                '-n', '-u', 'bot', '--', CLI_PATH, ...options.args,
            ], {
                cwd: options.cwd,
                signal: options.signal,
                env: { HOME: '/home/bot', PATH: '/usr/local/bin:/usr/bin:/bin' },
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
            });
    });

    it('passes only the proxy URL and a fixed dummy key in API key mode', () => {
        const spawnFunction = vi.fn(fakeProcess);
        const spawnAgent = createAgentUserSpawn({
            user: 'bot',
            executable: CLI_PATH,
            spawnFunction,
            environment: {
                HOME: '/var/lib/cloudbot',
                PATH: '/private/bin',
                ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
                ANTHROPIC_API_KEY: 'real-key',
                ANTHROPIC_AUTH_TOKEN: 'secret-token',
                SERVER_SECRET: 'private',
            },
        });

        spawnAgent(sdkSpawnOptions());

        expect(spawnFunction.mock.calls[0])
            .toEqual([
                '/usr/bin/sudo',
                expect.any(Array),
                expect.objectContaining({
                    env: {
                        HOME: '/home/bot',
                        PATH: '/usr/local/bin:/usr/bin:/bin',
                        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
                        ANTHROPIC_API_KEY: 'cloudbot-key-proxy',
                    },
                }),
            ]);
    });

    it('rejects another SDK executable without spawning', () => {
        const spawnFunction = vi.fn(fakeProcess);
        const spawnAgent = createAgentUserSpawn({ user: 'bot', executable: CLI_PATH, spawnFunction });

        expect(() => spawnAgent(sdkSpawnOptions({ command: '/bin/sh' })))
            .toThrow('unexpected agent executable');
        expect(spawnFunction).not.toHaveBeenCalled();
    });

    it('rejects invalid users and relative CLI paths', () => {
        expect(() => createAgentUserSpawn({ user: '../root', executable: CLI_PATH }))
            .toThrow('Invalid agent user');
        expect(() => createAgentUserSpawn({ user: 'bot', executable: 'claude' }))
            .toThrow('must be absolute');
    });

    it('leaves credentials out when no key proxy is configured', () => {
        expect(buildAgentEnvironment('bot', { ANTHROPIC_API_KEY: 'secret' }))
            .toEqual({
                HOME: '/home/bot', PATH: '/usr/local/bin:/usr/bin:/bin',
            });
    });
});
