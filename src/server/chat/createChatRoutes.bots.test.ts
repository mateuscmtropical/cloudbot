import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { createChatRoutes } from './createChatRoutes.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

describe('bot routes', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let chatService: ChatService;
    let app: Hono;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-bot-routes-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        chatService = new ChatService({ botStore, messageStore: new MessageStore(opened.db), runner: new FakeAgentRunner([]), dataDir });
        app = createChatRoutes(chatService);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('makes a new bot with a generic name and opens its chat with the question about its name and job', async () => {
        const response = await app.request('/api/bots', { method: 'POST' });
        const bot = await response.json() as { id: string; name: string };
        const messages = await chatService.listMessages(bot.id) as ChatMessage[];

        expect(response.status)
            .toBe(201);
        expect(bot.name)
            .toBe('New bot');
        const greetings = messages.map(message => JSON.stringify(message.body));

        expect(greetings)
            .toHaveLength(1);
        expect(greetings[0])
            .toContain('What should I be called');
    });

    it('deletes a bot that is not the last one, and the list no longer has it', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const response = await app.request(`/api/bots/${bot.id}`, { method: 'DELETE' });
        const listResponse = await app.request('/api/bots');
        const bots = await listResponse.json() as { name: string }[];

        expect(response.status)
            .toBe(200);
        expect(bots.map(listed => listed.name))
            .toEqual(['Ben']);
    });

    it('refuses the last bot with 409 and keeps it', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const response = await app.request(`/api/bots/${bot.id}`, { method: 'DELETE' });

        expect(response.status)
            .toBe(409);
        expect(await response.json())
            .toEqual({ error: 'The last bot cannot be deleted.' });
        expect(await botStore.getById(bot.id))
            .toBeDefined();
    });

    it('answers 409 to a message sent while the bot is being deleted', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        const heldService = new ChatService({
            botStore,
            messageStore: new MessageStore(opened.db),
            runner: new FakeAgentRunner([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]),
            dataDir,
        });
        const heldApp = createChatRoutes(heldService);

        await heldService.sendMessage(bot.id, 'Hello');

        const deleting = heldService.deleteBot(bot.id);
        const response = await heldApp.request(`/api/bots/${bot.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Again' }),
        });

        expect(response.status)
            .toBe(409);
        expect(await response.json())
            .toEqual({ error: 'This bot is being deleted.' });
        expect(await deleting)
            .toBe('deleted');
    });

    it('answers 404 for a bot that does not exist', async () => {
        await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const response = await app.request('/api/bots/no-such-bot', { method: 'DELETE' });

        expect(response.status)
            .toBe(404);
    });
});
