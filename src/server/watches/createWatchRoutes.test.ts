import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WatchStore } from '../store/WatchStore.ts';
import { createWatchRoutes } from './createWatchRoutes.ts';

describe('watch routes', () => {
    let opened: OpenedDatabase;
    let store: WatchStore;
    let botId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new WatchStore(opened.db);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
    });

    afterEach(() => {
        opened.close();
    });

    function createApp(): ReturnType<typeof createWatchRoutes> {
        return createWatchRoutes({ watchStore: store, hasBot: id => Promise.resolve(id === botId) });
    }

    it('lists the watches of a bot without the stored hash or text', async () => {
        await store.addWithLimit(botId, { name: 'Shop', url: 'https://shop.example.test/', intervalMinutes: 60, keyword: 'bread' }, 10);
        const [watch] = await store.list(botId);

        await store.setText(watch?.id ?? '', { textHash: 'a'.repeat(64), lastText: 'Bread 2' });

        const response = await createApp()
            .request(`/api/bots/${botId}/watches`);
        const listed: unknown = await response.json();

        expect(response.status)
            .toBe(200);
        expect(listed)
            .toEqual([expect.objectContaining({ name: 'Shop', url: 'https://shop.example.test/', intervalMinutes: 60, keyword: 'bread' })]);
        expect(JSON.stringify(listed))
            .not.toContain('Bread 2');
        expect(JSON.stringify(listed))
            .not.toContain('textHash');
    });

    it('answers 404 for a bot that does not exist', async () => {
        const response = await createApp()
            .request('/api/bots/missing/watches');

        expect(response.status)
            .toBe(404);
    });

    it('removes a watch of its own bot, and answers 404 for another id', async () => {
        await store.addWithLimit(botId, { name: 'Shop', url: 'https://shop.example.test/', intervalMinutes: 60, keyword: undefined }, 10);
        const [watch] = await store.list(botId);

        const missing = await createApp()
            .request(`/api/bots/${botId}/watches/unknown`, { method: 'DELETE' });
        const removed = await createApp()
            .request(`/api/bots/${botId}/watches/${watch?.id ?? ''}`, { method: 'DELETE' });

        expect(missing.status)
            .toBe(404);
        expect(removed.status)
            .toBe(204);
        expect(await store.list(botId))
            .toEqual([]);
    });
});
