import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { createClaudeReviewModel } from './createClaudeReviewModel.ts';
import type { ReviewQueryFunction } from './createClaudeReviewModel.ts';

function resultMessage(fields: Record<string, unknown>): SDKMessage {
    return { type: 'result', subtype: 'success', is_error: false, result: '{}', ...fields } as unknown as SDKMessage;
}

function createQuery(messages: SDKMessage[]): { queryFunction: ReviewQueryFunction; calls: { prompt: string; options: Options }[] } {
    const calls: { prompt: string; options: Options }[] = [];
    const queryFunction: ReviewQueryFunction = (parameters) => {
        calls.push(parameters);

        return Readable.from(messages) as AsyncIterable<SDKMessage>;
    };

    return { queryFunction, calls };
}

describe('createClaudeReviewModel', () => {
    it('runs the review with the model the owner chose', async () => {
        const { queryFunction, calls } = createQuery([resultMessage({ result: '{}' })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await askModel('prompt', undefined, 'haiku');

        expect(calls[0]?.options)
            .toMatchObject({ model: 'haiku' });
    });

    it('runs the review with the effort the owner chose', async () => {
        const { queryFunction, calls } = createQuery([resultMessage({ result: '{}' })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await askModel('prompt', undefined, undefined, 'max');

        expect(calls[0]?.options)
            .toMatchObject({ effort: 'max' });
    });

    it('runs the review with the CLI default effort when none is chosen', async () => {
        const { queryFunction, calls } = createQuery([resultMessage({ result: '{}' })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await askModel('prompt');

        expect(calls[0]?.options)
            .not.toHaveProperty('effort');
    });

    it('runs the review with the CLI default model when none is chosen', async () => {
        const { queryFunction, calls } = createQuery([resultMessage({ result: '{}' })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await askModel('prompt');

        expect(calls[0]?.options)
            .not.toHaveProperty('model');
    });

    it('returns the text of the result', async () => {
        const { queryFunction } = createQuery([{ type: 'system' } as unknown as SDKMessage, resultMessage({ result: 'answer' })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        const answer = await askModel('prompt');

        expect(answer)
            .toBe('answer');
    });

    it('runs with no tools, no settings, no saved session and one turn', async () => {
        const { queryFunction, calls } = createQuery([resultMessage({})]);
        const askModel = createClaudeReviewModel({
            workingDirectory: '/work',
            environment: { PATH: '/bin' },
            pathToClaudeCodeExecutable: '/usr/bin/claude',
            queryFunction,
        });

        await askModel('the prompt');

        expect(calls[0]?.prompt)
            .toBe('the prompt');
        expect(calls[0]?.options)
            .toMatchObject({
                cwd: '/work',
                tools: [],
                settingSources: [],
                persistSession: false,
                maxTurns: 1,
                env: { PATH: '/bin' },
                pathToClaudeCodeExecutable: '/usr/bin/claude',
            });
    });

    it('throws when the result is an error', async () => {
        const { queryFunction } = createQuery([resultMessage({ is_error: true })]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await expect(askModel('prompt'))
            .rejects
            .toThrow('did not answer');
    });

    it('throws when there is no result', async () => {
        const { queryFunction } = createQuery([]);
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });

        await expect(askModel('prompt'))
            .rejects
            .toThrow('no answer');
    });

    it('aborts the query when the signal fires', async () => {
        const abortSeen = vi.fn();
        const queryFunction: ReviewQueryFunction = ({ options }) => (async function* generate(): AsyncGenerator<SDKMessage> {
            await new Promise<void>((resolve) => {
                options.abortController?.signal.addEventListener('abort', () => {
                    abortSeen();
                    resolve();
                });
            });
            yield* [];
        })();
        const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction });
        const controller = new AbortController();
        const pending = askModel('prompt', controller.signal);

        controller.abort();

        await expect(pending)
            .rejects
            .toThrow('no answer');
        expect(abortSeen)
            .toHaveBeenCalledOnce();
    });

    it('aborts the query after the timeout', async () => {
        vi.useFakeTimers();

        try {
            const queryFunction: ReviewQueryFunction = ({ options }) => (async function* generate(): AsyncGenerator<SDKMessage> {
                await new Promise<void>((resolve) => {
                    options.abortController?.signal.addEventListener('abort', () => {
                        resolve();
                    });
                });
                yield* [];
            })();
            const askModel = createClaudeReviewModel({ workingDirectory: '/tmp', queryFunction, timeoutMs: 1000 });
            const pending = askModel('prompt');
            const settled = expect(pending)
                .rejects
                .toThrow('no answer');

            await vi.advanceTimersByTimeAsync(1000);
            await settled;
        } finally {
            vi.useRealTimers();
        }
    });
});
