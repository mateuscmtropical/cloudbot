import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { WebhookStore } from './WebhookStore.ts';

describe('WebhookStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let store: WebhookStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        store = new WebhookStore(opened.db, { now: () => Date.UTC(2026, 9, 21, 11, 0) });
    });

    afterEach(() => {
        opened.close();
    });

    it('adds a webhook with the hash it is given and lists it for its bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const added = await store.add(bot.id, 'Deploy', 'hash-one');

        expect(added.name)
            .toBe('Deploy');
        expect(added.tokenHash)
            .toBe('hash-one');
        expect(added.createdAt)
            .toBe(Date.UTC(2026, 9, 21, 11, 0));
        await expect(store.list(bot.id))
            .resolves.toEqual([added]);
    });

    it('finds a webhook by its token hash only', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const added = await store.add(bot.id, 'Deploy', 'hash-one');

        await expect(store.findByTokenHash('hash-one'))
            .resolves.toEqual(added);
        await expect(store.findByTokenHash('hash-two'))
            .resolves.toBeUndefined();
    });

    it('removes a webhook only for its own bot', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const added = await store.add(ana.id, 'Deploy', 'hash-one');

        await expect(store.remove(ben.id, added.id))
            .resolves.toBe(false);
        await expect(store.remove(ana.id, added.id))
            .resolves.toBe(true);
        await expect(store.remove(ana.id, added.id))
            .resolves.toBe(false);
    });
});
