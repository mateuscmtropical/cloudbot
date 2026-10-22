import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import { MessageStore } from './MessageStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import type { Bot, Message } from './types.ts';

describe('MessageStore', () => {
    let opened: OpenedDatabase;
    let currentTime: number;
    let messageStore: MessageStore;
    let bot: Bot;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        currentTime = 1000;
        const botStore = new BotStore(opened.db, { now: () => currentTime });

        bot = await botStore.create({ name: 'Ana', title: '', description: '' });
        messageStore = new MessageStore(opened.db, { now: () => currentTime });
    });

    afterEach(() => {
        opened.close();
    });

    it('removes the given messages of one bot and keeps the others', async () => {
        const otherBot = await new BotStore(opened.db)
            .create({ name: 'Bia', title: '', description: '' });
        const first = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { text: 'a' } });
        const second = await messageStore.add({ botId: bot.id, role: 'assistant', kind: 'text', content: { text: 'b' } });
        const third = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { text: 'c' } });
        const foreign = await messageStore.add({ botId: otherBot.id, role: 'user', kind: 'text', content: { text: 'd' } });

        await messageStore.removeMany(bot.id, [first.id, second.id, foreign.id]);

        const kept = await messageStore.listByBot(bot.id, { limit: 10 });
        const otherKept = await messageStore.listByBot(otherBot.id, { limit: 10 });

        expect(kept.map(message => message.id))
            .toEqual([third.id]);
        expect(otherKept)
            .toHaveLength(1);
    });

    it('adds a message and stores its content as JSON', async () => {
        const message = await messageStore.add({
            botId: bot.id,
            role: 'user',
            kind: 'text',
            content: { text: 'Hello', attachments: [] },
        });

        expect(message)
            .toEqual({
                id: expect.any(String) as string,
                sequence: 1,
                botId: bot.id,
                role: 'user',
                kind: 'text',
                content: { text: 'Hello', attachments: [] },
                createdAt: 1000,
            });
        await expect(messageStore.listByBot(bot.id, { limit: 10 }))
            .resolves.toEqual([message]);
    });

    it('lists the newest messages oldest first', async () => {
        const firstMessage = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: 'one' });

        currentTime = 2000;
        const secondMessage = await messageStore.add({ botId: bot.id, role: 'assistant', kind: 'text', content: 'two' });

        currentTime = 3000;
        const thirdMessage = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: 'three' });

        await expect(messageStore.listByBot(bot.id, { limit: 2 }))
            .resolves.toEqual([secondMessage, thirdMessage]);
        await expect(messageStore.listByBot(bot.id, { limit: 10 }))
            .resolves.toEqual([firstMessage, secondMessage, thirdMessage]);
    });

    it('pages backwards with beforeSequence', async () => {
        const messages = await [1000, 2000, 3000, 4000].reduce<Promise<Message[]>>(async (previousPromise, createdAt) => {
            const previous = await previousPromise;

            currentTime = createdAt;
            const added = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: createdAt });

            return [...previous, added];
        }, Promise.resolve([]));

        const firstPage = await messageStore.listByBot(bot.id, { limit: 2 });
        const oldestOfFirstPage = firstPage[0];
        const secondPage = await messageStore.listByBot(bot.id, {
            limit: 2,
            beforeSequence: oldestOfFirstPage?.sequence,
        });

        expect(firstPage)
            .toEqual([messages[2], messages[3]]);
        expect(secondPage)
            .toEqual([messages[0], messages[1]]);
    });

    it('pages through messages that share the same createdAt without repeats', async () => {
        currentTime = 5000;
        const messages = await [1, 2, 3, 4, 5].reduce<Promise<Message[]>>(async (previousPromise, index) => {
            const previous = await previousPromise;
            const added = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: index });

            return [...previous, added];
        }, Promise.resolve([]));

        const newestPage = await messageStore.listByBot(bot.id, { limit: 2 });
        const middlePage = await messageStore.listByBot(bot.id, { limit: 2, beforeSequence: newestPage[0]?.sequence });
        const oldestPage = await messageStore.listByBot(bot.id, { limit: 2, beforeSequence: middlePage[0]?.sequence });

        expect([...oldestPage, ...middlePage, ...newestPage])
            .toEqual(messages);
    });

    it('throws a clear error when content cannot be stored as JSON', async () => {
        await expect(messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: undefined }))
            .rejects.toThrow('Message content must be JSON-serializable');
    });

    it('keeps messages of other bots out of the list', async () => {
        const botStore = new BotStore(opened.db, { now: () => currentTime });
        const otherBot = await botStore.create({ name: 'Bia', title: '', description: '' });

        await messageStore.add({ botId: otherBot.id, role: 'user', kind: 'text', content: 'not mine' });

        await expect(messageStore.listByBot(bot.id, { limit: 10 }))
            .resolves.toEqual([]);
    });

    it('rejects a message for a bot that does not exist', async () => {
        await expect(messageStore.add({ botId: 'missing-id', role: 'user', kind: 'text', content: 'hi' }))
            .rejects.toThrow();
    });
});
