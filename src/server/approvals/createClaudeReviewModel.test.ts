import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeReviewModel } from './createClaudeReviewModel.ts';
import type { ReviewSpawnFunction } from './createClaudeReviewModel.ts';

interface FakeCli {
    process: ChildProcess;
    kill: ReturnType<typeof vi.fn>;
    stdinText(): string;
}

// A stand-in for the CLI. With an answer, it writes the answer once the prompt is read. Without one, it only ends when killed.
function fakeCli(answer: string | undefined): FakeCli {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const kill = vi.fn(() => {
        stdout.end();

        return true;
    });
    const child = Object.assign(new EventEmitter(), { stdin, stdout, kill });
    let received = '';

    stdin.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
    });
    stdin.on('finish', () => {
        if (answer !== undefined) {
            stdout.end(answer);
        }
    });
    stdout.on('end', () => {
        child.emit('close');
    });

    return {
        process: child as unknown as ChildProcess,
        kill,
        stdinText: () => received,
    };
}

function resultLine(fields: Record<string, unknown>): string {
    return `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', total_cost_usd: 0.01, ...fields })}\n`;
}

function spawnReturning(cli: FakeCli): ReturnType<typeof vi.fn<ReviewSpawnFunction>> {
    return vi.fn<ReviewSpawnFunction>(() => cli.process);
}

describe('createClaudeReviewModel', () => {
    it('runs the review with the model and effort the owner chose', async () => {
        const cli = fakeCli(resultLine({}));
        const spawnFunction = spawnReturning(cli);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', spawnFunction });

        await askModel('prompt', undefined, 'haiku', 'low');

        expect(spawnFunction.mock.calls[0]?.[1])
            .toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low']));
    });

    it('leaves out the model and effort when none is chosen', async () => {
        const cli = fakeCli(resultLine({}));
        const spawnFunction = spawnReturning(cli);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', spawnFunction });

        await askModel('prompt');

        const args = spawnFunction.mock.calls[0]?.[1] ?? [];

        expect(args).not.toContain('--model');
        expect(args).not.toContain('--effort');
    });

    it('returns the text of the result and sends the prompt on stdin', async () => {
        const cli = fakeCli(resultLine({ result: 'answer' }));
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', spawnFunction: spawnReturning(cli) });

        const answer = await askModel('the prompt');

        expect(answer)
            .toBe('answer');
        expect(cli.stdinText())
            .toBe('the prompt');
    });

    it('runs with no tools, no settings, no saved session and one JSON answer', async () => {
        const cli = fakeCli(resultLine({}));
        const spawnFunction = spawnReturning(cli);
        const askModel = createClaudeReviewModel({
            workingDirectory: '/work',
            environment: { PATH: '/bin' },
            pathToClaudeCodeExecutable: '/usr/bin/claude',
            spawnFunction,
        });

        await askModel('the prompt');

        const [command, args, options] = spawnFunction.mock.calls[0] ?? [];

        expect(command)
            .toBe('/usr/bin/claude');
        expect(args)
            .toEqual(expect.arrayContaining(['-p', '--output-format', 'json', '--no-session-persistence']));
        expect(args?.[args.indexOf('--tools') + 1])
            .toBe('');
        expect(args?.[args.indexOf('--setting-sources') + 1])
            .toBe('');
        expect(options)
            .toMatchObject({ cwd: '/work', env: { PATH: '/bin' }, shell: false });
    });

    it('throws when the result is an error', async () => {
        const askModel = createClaudeReviewModel({
            workingDirectory: '/tmp',
            spawnFunction: spawnReturning(fakeCli(resultLine({ is_error: true }))),
        });

        await expect(askModel('prompt'))
            .rejects
            .toThrow('did not answer');
    });

    it('throws when there is no answer', async () => {
        const askModel = createClaudeReviewModel({
            workingDirectory: '/tmp',
            spawnFunction: spawnReturning(fakeCli('')),
        });

        await expect(askModel('prompt'))
            .rejects
            .toThrow('no answer');
    });

    it('throws when the CLI cannot start', async () => {
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
        const askModel = createClaudeReviewModel({
            workingDirectory: '/tmp',
            spawnFunction: () => {
                queueMicrotask(() => child.emit('error', new Error('ENOENT')));

                return child as unknown as ChildProcess;
            },
        });

        await expect(askModel('prompt'))
            .rejects
            .toThrow('could not start');
    });

    it('stops the CLI when the signal fires', async () => {
        const cli = fakeCli(undefined);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', spawnFunction: spawnReturning(cli) });
        const controller = new AbortController();
        const pending = askModel('prompt', controller.signal);

        controller.abort();

        await expect(pending)
            .rejects
            .toThrow('no answer');
        expect(cli.kill)
            .toHaveBeenCalledOnce();
    });

    it('stops the CLI after the timeout', async () => {
        vi.useFakeTimers();

        try {
            const cli = fakeCli(undefined);
            const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', spawnFunction: spawnReturning(cli), timeoutMs: 1000 });
            const pending = askModel('prompt');
            const settled = expect(pending)
                .rejects
                .toThrow('no answer');

            await vi.advanceTimersByTimeAsync(1000);
            await settled;
            expect(cli.kill)
                .toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports the total cost of the review to onCost', async () => {
        const askModel = createClaudeReviewModel({
            workingDirectory: '/tmp',
            spawnFunction: spawnReturning(fakeCli(resultLine({ total_cost_usd: 0.42 }))),
        });
        const onCost = vi.fn();

        await askModel('prompt', undefined, undefined, undefined, onCost);

        expect(onCost)
            .toHaveBeenCalledWith(0.42);
    });
});
