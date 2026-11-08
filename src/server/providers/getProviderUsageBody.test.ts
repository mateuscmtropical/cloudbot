import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProviderUsageBody } from './getProviderUsageBody.ts';

interface FakeRun {
    spawnFunction: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    calls: { command: string; args: string[]; options: SpawnOptions }[];
    child: EventEmitter & { stdout: PassThrough };
}

// A stand-in for sudo and the wrapper. It has no pid, so a timeout signals nothing. The test says what it prints and how it ends.
function fakeRun(): FakeRun {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    const calls: FakeRun['calls'] = [];
    const spawnFunction = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
        calls.push({ command, args, options });

        return child as unknown as ChildProcess;
    };

    return { spawnFunction, calls, child };
}

describe('getProviderUsageBody', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs the usage action of the wrapper as the agent user and parses what it prints', async () => {
        const run = fakeRun();
        const body = getProviderUsageBody('copilot', { agentUser: 'bot', spawnFunction: run.spawnFunction });

        run.child.stdout.write('{"quota_snapshots":');
        run.child.stdout.write('{"chat":{"percent_remaining":50}}}');
        run.child.emit('close', 0);

        await expect(body).resolves.toEqual({ quota_snapshots: { chat: { percent_remaining: 50 } } });
        expect(run.calls[0]?.command)
            .toBe('/usr/bin/sudo');
        expect(run.calls[0]?.args)
            .toEqual(['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-provider', 'copilot', 'usage']);
    });

    it('fails when the wrapper ends with an error, such as a missing sign-in', async () => {
        const run = fakeRun();
        const body = getProviderUsageBody('kimi', { agentUser: 'bot', spawnFunction: run.spawnFunction });

        run.child.emit('close', 1);

        await expect(body).rejects.toThrow('The usage call gave no usage.');
    });

    it('fails when the answer is not JSON', async () => {
        const run = fakeRun();
        const body = getProviderUsageBody('kimi', { agentUser: 'bot', spawnFunction: run.spawnFunction });

        run.child.stdout.write('<html>');
        run.child.emit('close', 0);

        await expect(body).rejects.toThrow('The usage call gave no usage.');
    });

    it('fails when the wrapper cannot start', async () => {
        const run = fakeRun();
        const body = getProviderUsageBody('kimi', { agentUser: 'bot', spawnFunction: run.spawnFunction });

        run.child.emit('error', new Error('ENOENT'));

        await expect(body).rejects.toThrow('The usage call could not start.');
    });

    it('gives up on a call that never ends', async () => {
        vi.useFakeTimers();
        const run = fakeRun();
        const body = getProviderUsageBody('kimi', { agentUser: 'bot', spawnFunction: run.spawnFunction, timeoutMs: 1000 });
        const failure = expect(body).rejects.toThrow('The usage call took too long.');

        await vi.advanceTimersByTimeAsync(1001);
        await failure;
    });
});
