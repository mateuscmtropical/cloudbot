import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { ChannelStore } from '../store/ChannelStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { createChatRoutes } from './createChatRoutes.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

function putName(name: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) };
}

describe('rename bot route', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let channelStore: ChannelStore;
    let app: Hono;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-rename-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        channelStore = new ChannelStore(opened.db);
        const chatService = new ChatService({ botStore, messageStore: new MessageStore(opened.db), runner: new FakeAgentRunner([]), dataDir, channelStore });

        app = createChatRoutes(chatService);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('renames the bot and answers its summary with the new name', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const response = await app.request(`/api/bots/${bot.id}/name`, putName('  Maria  '));

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toMatchObject({ id: bot.id, name: 'Maria', title: 'Assistant' });
        expect((await botStore.getById(bot.id))?.name)
            .toBe('Maria');
    });

    it('refuses an empty name, a long one, one with a line break and a body without a name', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const path = `/api/bots/${bot.id}/name`;

        const empty = await app.request(path, putName('   '));
        const tooLong = await app.request(path, putName('x'.repeat(41)));
        const twoLines = await app.request(path, putName('Ma\nria'));
        const noName = await app.request(path, putName(undefined));

        expect([empty.status, tooLong.status, twoLines.status, noName.status])
            .toEqual([400, 400, 400, 400]);
        expect((await botStore.getById(bot.id))?.name)
            .toBe('Ana');
    });

    it('answers 404 for a bot that does not exist', async () => {
        const response = await app.request('/api/bots/missing/name', putName('Maria'));

        expect(response.status)
            .toBe(404);
    });

    it('refuses a name that another member of a channel of the bot already has', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await channelStore.create({ name: 'Project', managerId: ana.id, memberIds: [ana.id, ben.id] });

        const response = await app.request(`/api/bots/${ana.id}/name`, putName('ben'));

        expect(response.status)
            .toBe(409);
        expect(await response.json())
            .toEqual({ error: 'ben is already the name of a member of Project. Pick another name.' });
        expect((await botStore.getById(ana.id))?.name)
            .toBe('Ana');
    });

    it('keeps the same name when the bot is renamed to its own name', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await channelStore.create({ name: 'Project', managerId: ana.id, memberIds: [ana.id] });

        const response = await app.request(`/api/bots/${ana.id}/name`, putName('Ana'));

        expect(response.status)
            .toBe(200);
    });
});
