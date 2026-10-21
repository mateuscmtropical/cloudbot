import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('BotStore.delete', () => {
    let opened: OpenedDatabase;
    let store: BotStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new BotStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    it('removes the bot and its queued turns, and keeps the other bots', async () => {
        const bot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await store.create({ name: 'Ben', title: 'Assistant', description: '' });

        await store.insertQueuedTurn({ id: 'turn-1', botId: bot.id, position: 0, messageId: null, text: 'Continue.', uploads: [], source: 'chat' });
        await store.insertQueuedTurn({ id: 'turn-2', botId: otherBot.id, position: 1, messageId: null, text: 'Hi', uploads: [], source: 'chat' });

        await store.delete(bot.id);

        expect(await store.getById(bot.id))
            .toBeUndefined();
        expect((await store.list()).map(listed => listed.id))
            .toEqual([otherBot.id]);
        expect((await store.listQueuedTurns()).map(turn => turn.id))
            .toEqual(['turn-2']);
    });
});
