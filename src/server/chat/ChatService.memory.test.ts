import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner } from '../agent/AgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { createChatRoutes } from './createChatRoutes.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

class IdleRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return (async function* idle(): AsyncGenerator<AgentEvent> {
            await Promise.resolve();
            yield { type: 'turn_finished' };
        })();
    }
}

describe('the memory routes', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let service: ChatService;
    let botId: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-memory-chat-'));
        opened = await openDatabase(':memory:');

        const botStore = new BotStore(opened.db);
        const messageStore = new MessageStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        botId = bot.id;
        service = new ChatService({ botStore, messageStore, runner: new IdleRunner(), dataDir });
        await mkdir(service.workspaceFor(botId), { recursive: true });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    function putMemory(text: string, expectedText: string, id = botId): Promise<Response> {
        const routes = createChatRoutes(service);
        const body = JSON.stringify({ text, expectedText });

        return Promise.resolve(routes.request(`/api/bots/${id}/memory`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }));
    }

    it('reads the memory file and saves the change', async () => {
        const memoryPath = join(service.workspaceFor(botId), 'MEMORY.md');

        await writeFile(memoryPath, 'old');

        const routes = createChatRoutes(service);
        const readResponse = await routes.request(`/api/bots/${botId}/memory`);

        expect(await readResponse.json())
            .toEqual({ text: 'old', isCut: false });

        const saveResponse = await putMemory('new', 'old');

        expect(saveResponse.status)
            .toBe(200);
        expect(await readFile(memoryPath, 'utf8'))
            .toBe('new');
    });

    it('refuses a save when the bot changed the file since the owner read it', async () => {
        const memoryPath = join(service.workspaceFor(botId), 'MEMORY.md');

        await writeFile(memoryPath, 'the bot wrote this after');

        const response = await putMemory('new', 'old');

        expect(response.status)
            .toBe(409);
        expect(await readFile(memoryPath, 'utf8'))
            .toBe('the bot wrote this after');
    });

    it('refuses text past the cap, a file past the cap and an unknown bot', async () => {
        const memoryPath = join(service.workspaceFor(botId), 'MEMORY.md');
        const longText = 'x'.repeat(70_000);
        const tooLongResponse = await putMemory(longText, '');

        expect(tooLongResponse.status)
            .toBe(409);

        await writeFile(memoryPath, longText);

        const routes = createChatRoutes(service);
        const readResponse = await routes.request(`/api/bots/${botId}/memory`);
        const cut = await readResponse.json() as { text: string; isCut: boolean };

        expect(cut.isCut)
            .toBe(true);

        const cutResponse = await putMemory('short', cut.text);

        expect(cutResponse.status)
            .toBe(409);
        expect(await readFile(memoryPath, 'utf8'))
            .toBe(longText);

        const unknownResponse = await putMemory('text', '', 'no-such-bot');

        expect(unknownResponse.status)
            .toBe(404);
    });

    it('searches the chats of all bots', async () => {
        const messageStore = new MessageStore(opened.db);

        await messageStore.add({ botId, role: 'user', kind: 'text', content: { kind: 'text', text: 'the tea list' } });

        const routes = createChatRoutes(service);
        const response = await routes.request('/api/search?q=tea');
        const hits = await response.json() as unknown[];

        expect(hits)
            .toHaveLength(1);
    });
});
