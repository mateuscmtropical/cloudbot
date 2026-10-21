import { describe, expect, it, vi } from 'vitest';

import { createReviewContextReader } from './createReviewContextReader.ts';

const NO_CHOICES = { chat: null, routines: null, review: null };

describe('createReviewContextReader', () => {
    it('lists the rules and the text of the latest messages', async () => {
        const listByBot = vi.fn()
            .mockResolvedValue([
                { role: 'user', content: { kind: 'text', text: 'Book me a table' } },
                { role: 'assistant', content: { kind: 'toolActivity', toolName: 'Bash', status: 'done', summary: 'ls' } },
                { role: 'assistant', content: { kind: 'text', text: 'Which day?' } },
            ]);
        const list = vi.fn()
            .mockResolvedValue([
                { kind: 'block', text: 'Never email my boss.' },
                { kind: 'allow', text: 'Edit files in the workspace.' },
            ]);
        const get = vi.fn()
            .mockResolvedValue(NO_CHOICES);
        const readContext = createReviewContextReader({ ruleStore: { list }, messageStore: { listByBot }, modelStore: { get } });

        const context = await readContext('bot-1');

        expect(context)
            .toEqual({
                ownerRules: ['Block: Never email my boss.', 'Allow: Edit files in the workspace.'],
                recentMessages: ['Owner: Book me a table', 'Bot: Which day?'],
            });
    });

    it('carries the review model choice of the bot', async () => {
        const listByBot = vi.fn()
            .mockResolvedValue([]);
        const list = vi.fn()
            .mockResolvedValue([]);
        const get = vi.fn()
            .mockResolvedValue({ ...NO_CHOICES, review: 'haiku' });
        const readContext = createReviewContextReader({ ruleStore: { list }, messageStore: { listByBot }, modelStore: { get } });

        const context = await readContext('bot-1');

        expect(context.reviewModel)
            .toBe('haiku');
    });

    it('asks for a few messages of the right bot', async () => {
        const listByBot = vi.fn()
            .mockResolvedValue([]);
        const list = vi.fn()
            .mockResolvedValue([]);
        const get = vi.fn()
            .mockResolvedValue(NO_CHOICES);
        const readContext = createReviewContextReader({ ruleStore: { list }, messageStore: { listByBot }, modelStore: { get }, messageCount: 3 });

        await readContext('bot-9');

        expect(listByBot)
            .toHaveBeenCalledWith('bot-9', { limit: 3 });
    });
});
