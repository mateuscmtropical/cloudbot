import { describe, expect, it, vi } from 'vitest';

import { createDraftStore, EMPTY_DRAFT } from './draftStore.ts';

describe('createDraftStore', () => {
    it('tells listeners about a change until they leave', () => {
        const store = createDraftStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        const draft = { botId: 'bot-1', text: 'Hi', afterSequence: 3 };

        store.set(draft);
        store.set(draft);

        expect(store.get())
            .toBe(draft);
        expect(listener)
            .toHaveBeenCalledTimes(1);

        unsubscribe();
        store.set(EMPTY_DRAFT);

        expect(listener)
            .toHaveBeenCalledTimes(1);
    });
});
