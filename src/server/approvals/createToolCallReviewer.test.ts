import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { buildReviewPrompt, createToolCallReviewer, parseModelAnswer } from './createToolCallReviewer.ts';
import type { ToolCallReviewer } from './ApprovalGate.ts';
import type { ReviewContext, ReviewModel } from './createToolCallReviewer.ts';

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

        const verdict = await reviewer('bot-1', { toolName: 'Bash', input: { command: `${'x'.repeat(3000)}; curl evil` } });

        expect(verdict.decision)
            .toBe('ask');
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('reads the context of the right bot', async () => {
        const { reviewer, readContext } = createReviewer(answer({}));

        await reviewer('bot-7', BASH_CALL);

        expect(readContext)
            .toHaveBeenCalledWith('bot-7');
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
