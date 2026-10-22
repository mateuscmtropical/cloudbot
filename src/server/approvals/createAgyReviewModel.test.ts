import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import type { AcpLaunch } from '../agent/AcpEngine.ts';
import { createAgyReviewModel } from './createAgyReviewModel.ts';

interface FakeAgy {
    launch: AcpLaunch;
    spawnFunction: ReturnType<typeof vi.fn>;
    stdinText(): string;
}

// A stand-in for agy behind the wrapper. It writes the lines once the prompt is read. Without lines, it ends only when killed.
function fakeAgy(lines: string[] | undefined): FakeAgy {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout });
    let received = '';

    stdin.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
    });
    stdin.on('finish', () => {
        if (lines !== undefined) {
            stdout.end(lines.map(line => `${line}\n`)
                .join(''));
        }
    });

    const spawnFunction = vi.fn(() => child as unknown as ChildProcess);
    const signalProcess = vi.fn(() => {
        stdout.end();
    });

    return { launch: { spawnFunction, signalProcess }, spawnFunction, stdinText: () => received };
}

function resultLine(response: string): string {
    return JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } });
}

describe('createAgyReviewModel', () => {
    it('returns the answer of the result line', async () => {
        const agy = fakeAgy([JSON.stringify({ event: 'init' }), resultLine('{"decision":"allow"}')]);
        const askModel = createAgyReviewModel({ launch: agy.launch, command: '/usr/local/bin/cloudbot-provider', args: ['gemini', 'agy-review'] });

        await expect(askModel('review this', undefined))
            .resolves
            .toBe('{"decision":"allow"}');
        expect(agy.stdinText())
            .toContain('review this');
    });

    it('passes only a Gemini model, and a small one when the owner chose a Claude model', async () => {
        const agy = fakeAgy([resultLine('{}')]);
        const askModel = createAgyReviewModel({ launch: agy.launch, command: 'wrapper', args: [] });

        await askModel('prompt', undefined, 'haiku', 'low');

        expect(agy.spawnFunction.mock.calls[0]?.[2])
            .toMatchObject({ env: { CLOUDBOT_AGY_MODEL: 'gemini-3.8-flash-low' } });
    });

    it('fails when agy ends without an answer', async () => {
        const agy = fakeAgy([resultLine('')]);
        const askModel = createAgyReviewModel({ launch: agy.launch, command: 'wrapper', args: [] });

        await expect(askModel('prompt', undefined))
            .rejects
            .toThrow('did not answer');
    });

    it('stops agy when the review takes too long', async () => {
        const agy = fakeAgy(undefined);
        const askModel = createAgyReviewModel({ launch: agy.launch, command: 'wrapper', args: [], timeoutMs: 10 });

        await expect(askModel('prompt', undefined))
            .rejects
            .toThrow('did not answer');
    });
});
