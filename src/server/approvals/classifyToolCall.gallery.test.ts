import { describe, expect, it, vi } from 'vitest';

import { classifyToolCall } from './classifyToolCall.ts';
import { createToolCallReviewer } from './createToolCallReviewer.ts';

describe('gallery approvals', () => {
    it('lets the bot list the gallery without a review', () => {
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__gallery_list', input: {} }))
            .toBe('skip');
    });

    it('always asks the owner before an install or a share', () => {
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__gallery_install', input: { file: 'a.json' } }))
            .toBe('always-ask');
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__gallery_share', input: {} }))
            .toBe('always-ask');
    });

    it('takes the install and share cards from the stores, and never sends them to the review model', async () => {
        const askModel = vi.fn(() => Promise.resolve('{}'));
        const reviewer = createToolCallReviewer({
            askModel,
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeGalleryInstall: () => Promise.resolve({ decision: 'ask', summary: 'Install card.', detail: 'Name: "Ana"' }),
            describeGalleryShare: () => Promise.resolve({ decision: 'ask', summary: 'Share card.', detail: 'File: templates/ana.json' }),
        });
        const signal = new AbortController().signal;

        const installVerdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__gallery_install', input: { file: 'ana.json' } }, signal);
        const shareVerdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__gallery_share', input: {} }, signal);

        expect(installVerdict)
            .toEqual({ decision: 'ask', summary: 'Install card.', detail: 'Name: "Ana"' });
        expect(shareVerdict)
            .toEqual({ decision: 'ask', summary: 'Share card.', detail: 'File: templates/ana.json' });
        expect(askModel)
            .not.toHaveBeenCalled();
    });

    it('refuses a gallery change when its card cannot be built', async () => {
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
        });
        const verdict = await reviewer('bot-1', { toolName: 'mcp__cloudbot__gallery_share', input: {} }, new AbortController().signal);

        expect(verdict.decision)
            .toBe('deny');
    });
});
