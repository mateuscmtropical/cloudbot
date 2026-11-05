import { describe, expect, it, vi } from 'vitest';

import { createReviewChain } from './createReviewChain.ts';
import type { ReviewModel } from './createToolCallReviewer.ts';

function answering(answer: string): ReviewModel {
    return vi.fn<ReviewModel>()
        .mockResolvedValue(answer);
}

function failing(): ReviewModel {
    return vi.fn<ReviewModel>()
        .mockRejectedValue(new Error('down'));
}

describe('createReviewChain', () => {
    it('asks the chosen provider first with the owner choice', async () => {
        const claude = answering('claude');
        const chatgpt = answering('chatgpt');
        const chain = createReviewChain({ claude, chatgpt });

        expect(await chain('prompt', undefined, 'gpt-6', 'high', undefined, 'chatgpt'))
            .toBe('chatgpt');
        expect(chatgpt)
            .toHaveBeenCalledWith('prompt', undefined, 'gpt-6', 'high', undefined);
        expect(claude)
            .not.toHaveBeenCalled();
    });

    it('tries the others without the model of the chosen provider', async () => {
        const claude = answering('claude');
        const chain = createReviewChain({ claude, chatgpt: failing() });

        expect(await chain('prompt', undefined, 'gpt-6', 'high', undefined, 'chatgpt'))
            .toBe('claude');
        expect(claude)
            .toHaveBeenCalledWith('prompt', undefined);
    });

    it('keeps the usual order for a provider with no review model, without its model', async () => {
        const claude = answering('claude');
        const chain = createReviewChain({ claude });

        await chain('prompt', undefined, 'kimi-2', 'high', undefined, 'kimi');

        expect(claude)
            .toHaveBeenCalledWith('prompt', undefined, undefined, undefined, undefined);
    });

    it('stops trying once the turn stopped', async () => {
        const controller = new AbortController();
        const claude = answering('claude');
        const chatgpt = vi.fn<ReviewModel>(() => {
            controller.abort();

            return Promise.reject(new Error('stopped'));
        });
        const chain = createReviewChain({ claude, chatgpt });

        await expect(chain('prompt', controller.signal, undefined, undefined, undefined, 'chatgpt'))
            .rejects
            .toThrow('stopped');
        expect(claude)
            .not.toHaveBeenCalled();
    });
});
