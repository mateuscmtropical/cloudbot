import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { LimitStore } from '../store/LimitStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { ModelStore } from '../store/ModelStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OwnerNotice } from '../push/PushNotifier.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';

const NO_MODELS = { chat: null, routines: null, review: null, browsing: null, documents: null };

// Resolves on the turn event that reports the turn as finished. Subscribe before sending.
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

function scriptOf(events: AgentEvent[]): { event: AgentEvent }[] {
    return events.map(event => ({ event }));
}

// A replay has nothing to await. The runner still needs an async iterable.
// eslint-disable-next-line @typescript-eslint/require-await
async function* replayEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

// Each turn replays the next script, so a test can give the first part and the continuation different events.
class SequenceRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    private readonly scripts: AgentEvent[][];

    constructor(scripts: AgentEvent[][]) {
        this.scripts = scripts;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        const script = this.scripts[this.receivedRequests.length] ?? [];

        this.receivedRequests.push(request);

        return replayEvents(script);
    }
}

function waitForUsageLimitNotice(service: ChatService, botId: string): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'message' && event.message.body.kind === 'text' && event.message.body.text.startsWith('The usage limit was reached')) {
                unsubscribe();
                resolve();
            }
        });
    });
}

const LIMIT_PART: AgentEvent[] = [
    { type: 'session', sessionId: 'session-1' },
    { type: 'text', text: 'Looking at your inbox.' },
    { type: 'rate_limit', status: 'rejected' },
    { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true },
];

describe('ChatService check-ins', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let modelStore: ModelStore;
    let limitStore: LimitStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-checkin-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        modelStore = new ModelStore(opened.db);
        limitStore = new LimitStore(opened.db);
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    async function runCheckin(events: AgentEvent[], source: 'checkin' | 'routine' = 'checkin'): Promise<{ service: ChatService; botId: string; published: ChatEvent[]; runner: FakeAgentRunner }> {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(scriptOf(events));
        const service = new ChatService({ botStore, messageStore, runner, dataDir, modelStore, limitStore });
        const published: ChatEvent[] = [];

        service.subscribe(bot.id, (event) => {
            published.push(event);
        });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', source);
        await finished;

        return { service, botId: bot.id, published, runner };
    }

    it('stores and sends the full routine prompt unchanged', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const routinePrompt = 'Routine "Reminder": Send the message hi to the user.';
        const runner = new FakeAgentRunner(scriptOf([{ type: 'text', text: 'Done.' }, { type: 'turn_finished' }]));
        const service = new ChatService({ botStore, messageStore, runner, dataDir, modelStore, limitStore });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, routinePrompt, 'routine');
        await finished;

        const storedMessages = await messageStore.listByBot(bot.id, { limit: 10 });
        const storedRoutine = storedMessages[0];
        const agentRequest = runner.receivedRequests[0];

        expect(storedRoutine?.role)
            .toBe('user');
        expect(storedRoutine?.content)
            .toEqual({ kind: 'text', text: routinePrompt });
        expect(agentRequest?.prompt)
            .toBe(routinePrompt);
    });

    it('removes every message of a check-in that found nothing and tells the web app', async () => {
        const { service, botId, published } = await runCheckin([
            { type: 'tool_started', toolUseId: 't1', toolName: 'WebFetch', input: {} },
            { type: 'tool_finished', toolUseId: 't1', isError: false, output: 'ok' },
            { type: 'text', text: 'NOTHING_TO_REPORT' },
            { type: 'turn_finished' },
        ]);
        const remainingMessages = await service.listMessages(botId);
        const removedEvent = published.find(event => event.type === 'messagesRemoved');
        const shownIds = published.flatMap(event => (event.type === 'message' ? [event.message.id] : []));

        expect(remainingMessages)
            .toEqual([]);
        expect(removedEvent?.type === 'messagesRemoved' ? removedEvent.messageIds : [])
            .toEqual(shownIds);
        expect(shownIds)
            .toHaveLength(3);
    });

    it('keeps a check-in that has something to say', async () => {
        const { service, botId, published } = await runCheckin([
            { type: 'text', text: 'Your invoice is due tomorrow.' },
            { type: 'turn_finished' },
        ]);
        const remainingMessages = await service.listMessages(botId);

        expect(remainingMessages)
            .toHaveLength(2);
        expect(published.some(event => event.type === 'messagesRemoved'))
            .toBe(false);
    });

    it('sends no done notification for a quiet check-in, and one for a check-in with news', async () => {
        const notices: OwnerNotice[] = [];
        const notifyOwner = (notice: OwnerNotice): Promise<void> => {
            notices.push(notice);

            return Promise.resolve();
        };
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new SequenceRunner([
            [{ type: 'text', text: 'NOTHING_TO_REPORT' }, { type: 'turn_finished' }],
            [{ type: 'text', text: 'Your invoice is due tomorrow.' }, { type: 'turn_finished' }],
        ]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, modelStore, limitStore, notifyOwner });
        const quietFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', 'checkin');
        await quietFinished;
        const newsFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', 'checkin');
        await newsFinished;
        await vi.waitFor(() => {
            expect(notices)
                .toHaveLength(1);
        });

        const newest = ((await service.listMessages(bot.id)) ?? []).at(-1);

        expect(notices[0]?.messageId)
            .toBe(newest?.id);
    });

    it('keeps a check-in that ended with an error', async () => {
        const { service, botId } = await runCheckin([
            { type: 'text', text: 'NOTHING_TO_REPORT' },
            { type: 'turn_error', message: 'The turn failed.', isUsageLimit: false },
        ]);
        const remainingMessages = await service.listMessages(botId);

        expect(remainingMessages?.length)
            .toBeGreaterThan(0);
    });

    it('leaves a plain routine alone even when it replies with the quiet text', async () => {
        const { service, botId } = await runCheckin([
            { type: 'text', text: 'NOTHING_TO_REPORT' },
            { type: 'turn_finished' },
        ], 'routine');
        const remainingMessages = await service.listMessages(botId);

        expect(remainingMessages)
            .toHaveLength(2);
    });

    it('runs a check-in on the cheap model, whatever the chat model is, and under the routines limits', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner(scriptOf([{ type: 'text', text: 'NOTHING_TO_REPORT' }, { type: 'turn_finished' }]));
        const service = new ChatService({ botStore, messageStore, runner, dataDir, modelStore, limitStore });

        await modelStore.set(bot.id, { ...NO_MODELS, chat: 'opus' });
        await modelStore.setEfforts(bot.id, { chat: 'max', routines: null, review: null, browsing: null, documents: null });
        await limitStore.set(bot.id, {
            chat: { minutes: null, usd: 5, steps: 50 },
            routines: { minutes: null, usd: 0.2, steps: 8 },
        });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', 'checkin');
        await finished;

        const request = runner.receivedRequests[0];

        expect(request?.model)
            .toBe('haiku');
        expect(request?.effort)
            .toBeUndefined();
        expect(request?.maxSpendUsd)
            .toBe(0.2);
        expect(request?.maxSteps)
            .toBe(8);
    });

    it('removes the part before a usage limit wait, the wait notice and the prompt when the continuation is quiet', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new SequenceRunner([LIMIT_PART, [{ type: 'text', text: 'NOTHING_TO_REPORT' }, { type: 'turn_finished' }]]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', 'checkin');
        await noticeShown;

        const waitingMessages = await service.listMessages(bot.id);

        expect(waitingMessages?.length)
            .toBeGreaterThan(2);

        const resumed = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        await resumed;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Check-in "Inbox": look', 'Continue.']);
        await expect(service.listMessages(bot.id))
            .resolves.toEqual([]);

        service.dispose();
    });

    it('keeps everything when the continuation of a check-in has something to say', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new SequenceRunner([LIMIT_PART, [{ type: 'text', text: 'Your invoice is due.' }, { type: 'turn_finished' }]]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Check-in "Inbox": look', 'checkin');
        await noticeShown;

        const waitingMessages = await service.listMessages(bot.id);
        const resumed = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        await resumed;

        const finalMessages = await service.listMessages(bot.id);

        expect(finalMessages?.length)
            .toBe((waitingMessages?.length ?? 0) + 1);

        service.dispose();
    });
});
