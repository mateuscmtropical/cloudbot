import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import { ModelStore } from './ModelStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('ModelStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let store: ModelStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        store = new ModelStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    it('has no choices for a bot that never set any', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await store.get(bot.id))
            .toEqual({ chat: null, routines: null, review: null, browsing: null, documents: null });
    });

    it('keeps the choices that were set for the bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.set(bot.id, { chat: 'haiku', routines: 'claude-sonnet-4-5', review: null, browsing: null, documents: null });

        expect(await store.get(bot.id))
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: null, browsing: null, documents: null });
    });

    it('replaces every choice on a second set, and clears one set to null', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.set(bot.id, { chat: 'haiku', routines: 'opus', review: 'fable', browsing: null, documents: null });
        await store.set(bot.id, { chat: 'sonnet', routines: null, review: null, browsing: null, documents: null });

        expect(await store.get(bot.id))
            .toEqual({ chat: 'sonnet', routines: null, review: null, browsing: null, documents: null });
    });

    it('keeps the choices of each bot apart', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await store.set(ana.id, { chat: 'haiku', routines: null, review: null, browsing: null, documents: null });

        expect(await store.get(ben.id))
            .toEqual({ chat: null, routines: null, review: null, browsing: null, documents: null });
    });

    it('has no efforts for a bot that never set any', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await store.getEfforts(bot.id))
            .toEqual({ chat: null, routines: null, review: null, browsing: null, documents: null });
    });

    it('keeps the efforts that were set, and replaces them on a second set', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.setEfforts(bot.id, { chat: 'high', routines: 'max', review: null, browsing: 'low', documents: null });
        await store.setEfforts(bot.id, { chat: 'medium', routines: null, review: null, browsing: null, documents: null });

        expect(await store.getEfforts(bot.id))
            .toEqual({ chat: 'medium', routines: null, review: null, browsing: null, documents: null });
    });

    it('keeps the models when the efforts are set, and the efforts when the models are set', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.set(bot.id, { chat: 'haiku', routines: null, review: null, browsing: null, documents: null });
        await store.setEfforts(bot.id, { chat: 'xhigh', routines: null, review: null, browsing: null, documents: null });
        await store.set(bot.id, { chat: 'opus', routines: null, review: null, browsing: null, documents: null });

        expect(await store.get(bot.id))
            .toEqual({ chat: 'opus', routines: null, review: null, browsing: null, documents: null });
        expect(await store.getEfforts(bot.id))
            .toEqual({ chat: 'xhigh', routines: null, review: null, browsing: null, documents: null });
    });
});
