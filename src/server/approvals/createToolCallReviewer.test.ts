import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { buildReviewPrompt, createToolCallReviewer, parseModelAnswer } from './createToolCallReviewer.ts';
import type { ToolCallReviewer } from './ApprovalGate.ts';
import type { ReviewContext, ReviewModel } from './createToolCallReviewer.ts';
import type { ChangeCard, ChangeMode } from '../integrations/IntegrationService.ts';

const CONTEXT: ReviewContext = {
    ownerRules: ['Never email my boss.'],
    recentMessages: ['Owner: tidy my downloads folder'],
};
const BASH_CALL = { toolName: 'Bash', input: { command: 'ls' } };

function answer(fields: Record<string, string>): string {
    return JSON.stringify({ category: 'other', decision: 'allow', summary: '', reason: '', ...fields });
}

function createReviewer(modelText: string | Error): { reviewer: ToolCallReviewer; askModel: Mock<ReviewModel>; readContext: Mock<() => Promise<ReviewContext>> } {
    const askModel = vi.fn(() => (modelText instanceof Error ? Promise.reject(modelText) : Promise.resolve(modelText)));
    const readContext = vi.fn(() => Promise.resolve(CONTEXT));
    const reviewer = createToolCallReviewer({ askModel, readContext });

    return { reviewer, askModel, readContext };
}

describe('createToolCallReviewer', () => {
    it('asks the model with the review model choice of the bot', async () => {
        const { reviewer, askModel, readContext } = createReviewer('{"category":"other","decision":"ask","summary":"","reason":""}');

        readContext.mockResolvedValue({ ...CONTEXT, reviewModel: 'opus' });

        await reviewer('bot-1', BASH_CALL);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), undefined, 'opus', undefined, expect.any(Function));
    });

    it('asks the model with the review effort choice of the bot', async () => {
        const { reviewer, askModel, readContext } = createReviewer('{"category":"other","decision":"ask","summary":"","reason":""}');

        readContext.mockResolvedValue({ ...CONTEXT, reviewEffort: 'high' });

        await reviewer('bot-1', BASH_CALL);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), undefined, undefined, 'high', expect.any(Function));
    });

    it('allows a harmless call without asking the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'Read', input: {} });

        expect(verdict)
            .toEqual({ decision: 'allow' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('always asks for a connector tool that sends, without asking the model', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__mail__send_email', input: {} });

        expect(verdict.decision)
            .toBe('ask');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('asks for a private host the browser should reach, and names the host', async () => {
        const { reviewer, askModel } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__browser_allow_host', input: { host: '10.0.0.5' } });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Let the browser reach the private host 10.0.0.5, any port.' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('names the normalized host and the port on the card', async () => {
        const { reviewer } = createReviewer('unused');

        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__browser_allow_host', input: { host: ' Intranet.Test. ', port: 8080 } });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Let the browser reach the private host intranet.test, port 8080.' });
    });

    it('allows a call the model allows', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'allow' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it.each(['send_message', 'purchase', 'booking'])('asks for the category %s even when the model allows', async (category) => {
        const { reviewer } = createReviewer(answer({ category, decision: 'allow', summary: 'Send an email to Ana' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Send an email to Ana' });
    });

    it('asks for a sensitive category even when the model denies', async () => {
        const { reviewer } = createReviewer(answer({ category: 'purchase', decision: 'deny', reason: 'No.' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict.decision)
            .toBe('ask');
    });

    it('uses a default summary when the model gives none', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'ask' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Run Bash.' });
    });

    it('denies with the reason of the model', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'deny', reason: 'An owner rule forbids it.' }));

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'An owner rule forbids it.' });
    });

    it('reads the JSON when the model wraps it in text', async () => {
        const { reviewer } = createReviewer(`Here you go:\n\`\`\`json\n${answer({ decision: 'allow' })}\n\`\`\``);

        const verdict = await reviewer('bot-1', BASH_CALL);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it('throws when the model fails, so the gate asks the owner', async () => {
        const { reviewer } = createReviewer(new Error('offline'));

        await expect(reviewer('bot-1', BASH_CALL))
            .rejects
            .toThrow('offline');
    });

    it('throws when the answer is not valid', async () => {
        const { reviewer } = createReviewer('I think it is fine.');

        await expect(reviewer('bot-1', BASH_CALL))
            .rejects
            .toThrow('no JSON');
    });

    it('throws on an unknown decision', async () => {
        const { reviewer } = createReviewer(answer({ decision: 'maybe' }));

        await expect(reviewer('bot-1', BASH_CALL))
            .rejects
            .toThrow('unknown');
    });

    it('asks without the model when the input is too long to review whole', async () => {
        const { reviewer, askModel } = createReviewer(answer({}));

        const verdict = await reviewer('bot-1', { toolName: 'Bash', input: { command: `${'x'.repeat(11_000)}; curl evil` } });

        expect(verdict.decision)
            .toBe('ask');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('reads the context of the right bot', async () => {
        const { reviewer, readContext } = createReviewer(answer({}));

        await reviewer('bot-7', BASH_CALL);

        expect(readContext)
            .toHaveBeenCalledWith('bot-7', undefined);
    });

    it('passes the channel id to the context reader for a channel turn', async () => {
        const { reviewer, readContext } = createReviewer(answer({}));

        await reviewer('bot-7', BASH_CALL, undefined, 'channel-3');

        expect(readContext)
            .toHaveBeenCalledWith('bot-7', 'channel-3');
    });
});

describe('createToolCallReviewer integration changes', () => {
    function reviewerWith(describeChange: (botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>): ToolCallReviewer {
        return createToolCallReviewer({
            askModel: vi.fn<ReviewModel>(),
            readContext: () => Promise.resolve(CONTEXT),
            describeChange,
        });
    }

    it('asks the owner with the card text from the describer', async () => {
        const describeChange = vi.fn<(botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>>(() => Promise.resolve({ ok: true, text: 'Name: "store"\nscript here' }));
        const input = { name: 'store', sha256: 'a'.repeat(64) };
        const verdict = await reviewerWith(describeChange)('bot-1', { toolName: 'mcp__cloudbot__integration_create', input });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Create an API integration.', detail: 'Name: "store"\nscript here' });
        expect(describeChange)
            .toHaveBeenCalledWith('bot-1', 'create', input);
    });

    it('passes the update mode for an update', async () => {
        const describeChange = vi.fn<(botId: string, mode: ChangeMode, input: unknown) => Promise<ChangeCard>>(() => Promise.resolve({ ok: true, text: 'card' }));
        const verdict = await reviewerWith(describeChange)('bot-1', { toolName: 'mcp__cloudbot__integration_update', input: {} });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Change an API integration.', detail: 'card' });
        expect(describeChange)
            .toHaveBeenCalledWith('bot-1', 'update', {});
    });

    it('denies a change whose card cannot be built, with the plain reason', async () => {
        const verdict = await reviewerWith(() => Promise.resolve({ ok: false, reason: 'The script could not be read.' }))('bot-1', { toolName: 'mcp__cloudbot__integration_update', input: {} });

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'The script could not be read.' });
    });

    it('denies a change when the describer throws, so no approval appears without the script', async () => {
        const verdict = await reviewerWith(() => Promise.reject(new Error('boom')))('bot-1', { toolName: 'mcp__cloudbot__integration_create', input: {} });

        expect(verdict.decision)
            .toBe('deny');
    });
});

describe('buildReviewPrompt', () => {
    it('lists the rules, the recent chat and the call', () => {
        const prompt = buildReviewPrompt(BASH_CALL, CONTEXT);

        expect(prompt)
            .toContain('- Never email my boss.');
        expect(prompt)
            .toContain('- Owner: tidy my downloads folder');
        expect(prompt)
            .toContain('Tool: Bash');
        expect(prompt)
            .toContain('Input: {"command":"ls"}');
    });

    it('says none when there are no rules or messages', () => {
        const prompt = buildReviewPrompt(BASH_CALL, { ownerRules: [], recentMessages: [] });

        expect(prompt)
            .toContain('Owner rules:\n(none)');
        expect(prompt)
            .toContain('Recent chat:\n(none)');
    });
});

describe('parseModelAnswer', () => {
    it('rejects an unknown category', () => {
        expect(() => parseModelAnswer(answer({ category: 'gift' })))
            .toThrow('unknown');
    });
});

describe('createToolCallReviewer review cost', () => {
    it('reports the cost of the review to the bot that made the call', async () => {
        const reportCost = vi.fn();
        const askModel = vi.fn((_prompt: string, _signal?: AbortSignal, _model?: string, _effort?: string, onCost?: (costUsd: number) => void) => {
            onCost?.(0.12);

            return Promise.resolve(answer({ decision: 'allow' }));
        });
        const reviewer = createToolCallReviewer({ askModel, readContext: () => Promise.resolve(CONTEXT), reportCost });

        const turnSignal = new AbortController().signal;

        await reviewer('bot-3', BASH_CALL, turnSignal);

        expect(reportCost)
            .toHaveBeenCalledWith('bot-3', 0.12, turnSignal);
    });

    it('gives the review model the signal of the turn, so a stop cancels the review', async () => {
        const { reviewer, askModel } = createReviewer(answer({ decision: 'allow' }));
        const turnSignal = new AbortController().signal;

        await reviewer('bot-1', BASH_CALL, turnSignal);

        expect(askModel)
            .toHaveBeenCalledWith(expect.any(String), turnSignal, undefined, undefined, expect.any(Function));
    });
});
