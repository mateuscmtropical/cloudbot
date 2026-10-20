import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('BotStore', () => {
    let opened: OpenedDatabase;
    let currentTime: number;
    let store: BotStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        currentTime = 1000;
        store = new BotStore(opened.db, { now: () => currentTime });
    });

    afterEach(() => {
        opened.close();
    });

    it('lists queued turns in position order, including ones put in front', async () => {
        const bot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });
        const back = { id: 'back', botId: bot.id, position: 1, messageId: 'm2', text: 'second', uploads: [] };
        const front = { id: 'front', botId: bot.id, position: 0, messageId: null, text: 'Continue.', uploads: [] };

        await store.insertQueuedTurn(back);
        await store.insertQueuedTurn(front);

        expect((await store.listQueuedTurns()).map(turn => turn.id))
            .toEqual(['front', 'back']);
    });

    it('drops the queued turns of a bot when they are deleted for it', async () => {
        const bot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.insertQueuedTurn({ id: 'turn-1', botId: bot.id, position: 1, messageId: 'm1', text: 'Hi', uploads: [] });
        await store.deleteQueuedTurnsOfBot(bot.id);

        expect(await store.listQueuedTurns())
            .toEqual([]);
    });

    it('keeps one usage wait per bot and removes it', async () => {
        const bot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.setUsageWait(bot.id, 5000);
        await store.setUsageWait(bot.id, 9000);

        expect(await store.listUsageWaits())
            .toEqual([{ botId: bot.id, resumeAt: 9000 }]);

        await store.deleteUsageWait(bot.id);

        expect(await store.listUsageWaits())
            .toEqual([]);
    });

    it('creates a bot with no session and the current time', async () => {
        const bot = await store.create({ name: 'Ana', title: 'Assistant', description: 'Helps with mail' });

        expect(bot)
            .toEqual({
                id: expect.any(String) as string,
                name: 'Ana',
                title: 'Assistant',
                description: 'Helps with mail',
                sessionId: null,
                createdAt: 1000,
            });
    });

    it('gets a bot by id and returns undefined for an unknown id', async () => {
        const createdBot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });

        await expect(store.getById(createdBot.id))
            .resolves.toEqual(createdBot);
        await expect(store.getById('missing-id'))
            .resolves.toBeUndefined();
    });

    it('lists bots oldest first', async () => {
        const firstBot = await store.create({ name: 'First', title: '', description: '' });

        currentTime = 2000;
        const secondBot = await store.create({ name: 'Second', title: '', description: '' });

        await expect(store.list())
            .resolves.toEqual([firstBot, secondBot]);
    });

    it('updates the profile fields and keeps the session id', async () => {
        const createdBot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.setSessionId(createdBot.id, 'session-1');
        const updatedBot = await store.updateProfile(createdBot.id, { name: 'Bia', title: 'Editor', description: 'Edits text' });

        expect(updatedBot)
            .toEqual({
                ...createdBot,
                name: 'Bia',
                title: 'Editor',
                description: 'Edits text',
                sessionId: 'session-1',
            });
    });

    it('stores and clears the session id', async () => {
        const createdBot = await store.create({ name: 'Ana', title: '', description: '' });

        const withSession = await store.setSessionId(createdBot.id, 'session-1');
        const withoutSession = await store.setSessionId(createdBot.id, null);

        expect(withSession?.sessionId)
            .toBe('session-1');
        expect(withoutSession?.sessionId)
            .toBeNull();
    });

    it('updates only the fields that are passed and keeps the others', async () => {
        const createdBot = await store.create({ name: 'Ana', title: 'Assistant', description: 'Helps with mail' });

        const updatedBot = await store.updateProfile(createdBot.id, { title: 'Editor' });

        expect(updatedBot)
            .toEqual({ ...createdBot, title: 'Editor' });
    });

    it('returns the bot unchanged when no field is passed', async () => {
        const createdBot = await store.create({ name: 'Ana', title: 'Assistant', description: '' });

        await expect(store.updateProfile(createdBot.id, {}))
            .resolves.toEqual(createdBot);
    });

    it('returns undefined when updating a bot that does not exist', async () => {
        await expect(store.updateProfile('missing-id', { name: '', title: '', description: '' }))
            .resolves.toBeUndefined();
        await expect(store.setSessionId('missing-id', 'session-1'))
            .resolves.toBeUndefined();
    });
});
