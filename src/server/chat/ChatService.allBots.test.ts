import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

function waitForTurnFinish(service: ChatService, botId: string): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'turn' && !event.isRunning) {
                unsubscribe();
                resolve();
            }
        });
    });
}

describe('ChatService messages of every bot', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-allbots-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        vi.restoreAllMocks();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('sends the events of every bot to a listener of all bots until it unsubscribes', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const received: ChatEvent[] = [];
        const unsubscribe = service.subscribeToAllBots(event => received.push(event));
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        unsubscribe();

        const countAfterUnsubscribe = received.length;
        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Again');
        await secondFinished;

        expect(received.some(event => event.type === 'message'))
            .toBe(true);
        expect(received)
            .toHaveLength(countAfterUnsubscribe);
    });

    it('gives the sequence of the newest message the owner can read', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const before = await service.listBots();
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const after = await service.listBots();
        const messages = (await service.listMessages(bot.id)) ?? [];
        const reply = messages.filter(message => message.role === 'assistant')
            .at(-1);

        expect(before.find(summary => summary.id === bot.id)?.lastMessageSequence)
            .toBe(0);
        expect(reply?.sequence)
            .toBeGreaterThan(0);
        expect(after.find(summary => summary.id === bot.id)?.lastMessageSequence)
            .toBe(reply?.sequence);
    });
});
