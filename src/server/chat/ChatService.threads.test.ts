import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ThreadSummary } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

const SLOW_TURN_MS = 150;

function waitUntilIdle(service: ChatService, ...botIds: string[]): Promise<void> {
    return new Promise((resolve) => {
        const check = (): void => {
            if (botIds.some(botId => service.isBusy(botId))) {
                setTimeout(check, 10);

                return;
            }

            resolve();
        };

        check();
    });
}

async function createThreadOrFail(service: ChatService, botId: string): Promise<ThreadSummary> {
    const thread = await service.createThread(botId);

    if (thread === undefined || thread === 'full') {
        throw new Error('The thread was not created.');
    }

    return thread;
}

describe('ChatService threads', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-threads-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        vi.restoreAllMocks();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('lists the own chat first and keeps the threads out of the list of bots', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(service, bot.id);
        const threads = await service.listThreads(bot.id);
        const bots = await service.listBots();

        expect(threads)
            .toEqual([
                { id: bot.id, name: 'Ana', isDefault: true, isRunning: false },
                { id: thread.id, name: 'New chat', isDefault: false, isRunning: false },
            ]);
        expect(bots.map(listed => listed.id))
            .toEqual([bot.id]);
        expect(await service.listThreads(thread.id))
            .toBeUndefined();
    });

    it('gives a thread its own history and session and names it after its first message', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'session', sessionId: 'session-x' } }, { event: { type: 'text', text: 'Done.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(service, bot.id);

        await service.sendMessage(thread.id, 'Plan the trip to Rome please');
        await waitUntilIdle(service, thread.id);

        const threadMessages = await service.listMessages(thread.id);
        const botMessages = await service.listMessages(bot.id);
        const storedThread = await botStore.getById(thread.id);
        const storedBot = await botStore.getById(bot.id);

        expect(threadMessages?.map(message => message.role))
            .toEqual(['user', 'assistant']);
        expect(botMessages)
            .toEqual([]);
        expect(storedThread?.sessionId)
            .toBe('session-x');
        expect(storedBot?.sessionId)
            .toBeNull();
        expect(storedThread?.name)
            .toBe('Plan the trip to Rome please');
    });

    it('runs a thread turn in the folder and with the identity of its bot', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(service, bot.id);

        await service.sendMessage(thread.id, 'Hi');
        await waitUntilIdle(service, thread.id);

        expect(runner.receivedRequests[0]?.botId)
            .toBe(bot.id);
        expect(runner.receivedRequests[0]?.workspaceDir)
            .toBe(service.workspaceFor(bot.id));
        expect(service.workspaceFor(thread.id))
            .toBe(service.workspaceFor(bot.id));
    });

    it('runs the own chat and a thread at the same time', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' }, delayMs: SLOW_TURN_MS }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(service, bot.id);

        await service.sendMessage(bot.id, 'One');
        await service.sendMessage(thread.id, 'Two');

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(service.isTurnRunning(thread.id))
            .toBe(true);
        expect(service.isBotBusy(bot.id))
            .toBe(true);

        await waitUntilIdle(service, bot.id, thread.id);

        expect(service.isBotBusy(bot.id))
            .toBe(false);
    });

    it('queues a chat past the parallel limit and starts it when another ends', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' }, delayMs: SLOW_TURN_MS }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const first = await createThreadOrFail(service, bot.id);
        const second = await createThreadOrFail(service, bot.id);
        const third = await createThreadOrFail(service, bot.id);
        const lanes = [bot.id, first.id, second.id, third.id];

        await Promise.all(lanes.map(laneId => service.sendMessage(laneId, 'Go')));

        const runningCount = lanes.filter(laneId => service.isTurnRunning(laneId)).length;

        expect(runningCount)
            .toBe(3);
        expect(service.isTurnRunning(third.id))
            .toBe(false);
        expect(service.isBusy(third.id))
            .toBe(true);

        await waitUntilIdle(service, ...lanes);

        const thirdMessages = await service.listMessages(third.id);

        expect(thirdMessages?.map(message => message.role))
            .toEqual(['user', 'assistant']);
        expect(runner.receivedRequests)
            .toHaveLength(4);
    });

    it('refuses a ninth thread', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const creations = Array.from({ length: 8 }, () => createThreadOrFail(service, bot.id));

        await Promise.all(creations);

        expect(await service.createThread(bot.id))
            .toBe('full');
    });

    it('removes a thread with its messages, and the threads go with their bot', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' } }]), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const other = await botStore.create({ name: 'Bo', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(service, bot.id);
        const keptThread = await createThreadOrFail(service, bot.id);

        await service.sendMessage(thread.id, 'Hi');
        await waitUntilIdle(service, thread.id);

        expect(await service.removeThread(other.id, thread.id))
            .toBe(false);
        expect(await service.removeThread(bot.id, thread.id))
            .toBe(true);
        expect(await botStore.getById(thread.id))
            .toBeUndefined();
        expect(await messageStore.listByBot(thread.id, { limit: 10 }))
            .toEqual([]);
        expect(await service.deleteBot(bot.id))
            .toBe('deleted');
        expect(await botStore.getById(keptThread.id))
            .toBeUndefined();
    });

    it('finds the threads again after a restart', async () => {
        const first = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const thread = await createThreadOrFail(first, bot.id);
        const second = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });

        await second.resumeQueue();

        expect(second.workspaceFor(thread.id))
            .toBe(second.workspaceFor(bot.id));
    });
});
