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

    it('finds shown messages by prefix, without accents, newest first, and marks the match', async () => {
        const older = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'Reunião com a Ana' } });
        const newer = await messageStore.add({ botId: bot.id, role: 'assistant', kind: 'choice', content: { kind: 'choice', prompt: 'Marcar reuniao?', options: [] } });

        await messageStore.add({ botId: bot.id, role: 'assistant', kind: 'toolActivity', content: { kind: 'toolActivity', toolName: 'x', status: 'done', summary: 'reuniao' } });

        const hits = await messageStore.search('reuni', 10);

        expect(hits.map(hit => hit.messageId))
            .toEqual([newer.id, older.id]);
        expect(hits[1]?.snippet)
            .toBe('\u0002Reunião\u0003 com a Ana');
    });

    it('reads search syntax and quotes as plain words', async () => {
        await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'say "NOT" here' } });

        const hits = await messageStore.search('"NOT" body: *', 10);
        const emptyHits = await messageStore.search('   ', 10);

        expect(hits)
            .toEqual([]);
        expect(emptyHits)
            .toEqual([]);
        expect(await messageStore.search('"not"', 10))
            .toHaveLength(1);
    });

    it('keeps the search index in step with edits, removals and a deleted bot', async () => {
        const edited = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'alpha' } });
        const removed = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'beta' } });
        const botStore = new BotStore(opened.db);
        const otherBot = await botStore.create({ name: 'Bia', title: '', description: '' });

        await messageStore.add({ botId: otherBot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'gamma' } });
        await messageStore.updateContent(edited.id, { kind: 'text', text: 'delta' });
        await messageStore.removeMany(bot.id, [removed.id]);
        await botStore.delete(otherBot.id);

        const words = ['alpha', 'delta', 'beta', 'gamma'];
        const hitLists = await Promise.all(words.map(word => messageStore.search(word, 10)));
        const hitCounts = hitLists.map(hits => hits.length);

        expect(hitCounts)
            .toEqual([0, 1, 0, 0]);
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
                emailDeliveryId: null,
                emailTaskHandledAt: null,
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

    it('finds a message by its stable email delivery id and refuses a duplicate id', async () => {
        const emailMessage = await messageStore.add({
            botId: bot.id,
            role: 'user',
            kind: 'text',
            content: { kind: 'text', text: 'Incoming mail' },
            emailDeliveryId: 'bot-one:v1:11',
        });

        await expect(messageStore.getByEmailDeliveryId('bot-one:v1:11'))
            .resolves.toEqual(emailMessage);
        await expect(messageStore.add({
            botId: bot.id,
            role: 'user',
            kind: 'text',
            content: { kind: 'text', text: 'Duplicate mail' },
            emailDeliveryId: 'bot-one:v1:11',
        }))
            .rejects.toThrow();
    });

    it('marks a mail task handled once without changing other messages', async () => {
        const emailMessage = await messageStore.add({
            botId: bot.id,
            role: 'user',
            kind: 'text',
            content: 'Incoming mail',
            emailDeliveryId: 'bot-one:v1:11',
        });
        const regularMessage = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: 'Owner message' });

        await expect(messageStore.markEmailTaskHandled(regularMessage.id))
            .resolves.toBe(false);
        await expect(messageStore.markEmailTaskHandled(emailMessage.id))
            .resolves.toBe(true);
        await expect(messageStore.markEmailTaskHandled(emailMessage.id))
            .resolves.toBe(false);
        const handledMessage = await messageStore.getById(emailMessage.id);

        expect(handledMessage?.emailTaskHandledAt)
            .toBeTypeOf('number');
    });

    it('rejects a message for a bot that does not exist', async () => {
        await expect(messageStore.add({ botId: 'missing-id', role: 'user', kind: 'text', content: 'hi' }))
            .rejects.toThrow();
    });
});
