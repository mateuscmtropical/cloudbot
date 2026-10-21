import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { ScreenHolder } from '../desktop/ScreenHolder.ts';
import { LimitStore } from '../store/LimitStore.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import type { TurnLimits } from '../../shared/limitTypes.ts';
import { ChatService } from './ChatService.ts';

const MINUTE_MS = 60_000;
const NO_LIMITS: TurnLimits = {
    chat: { minutes: null, usd: null, steps: null },
    routines: { minutes: null, usd: null, steps: null },
};

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

async function* waitForAbort(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

// A turn that works until it is stopped, like a long task. Its clock is the only thing that can end it.
class LongTurnRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    // Resolves when the runner gets its first turn. The clock of a turn starts before this.
    readonly started: Promise<void>;
    private markStarted: () => void = () => undefined;

    constructor() {
        this.started = new Promise<void>((resolve) => {
            this.markStarted = resolve;
        });
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.receivedRequests.push(request);
        this.markStarted();

        return waitForAbort(request.abortSignal);
    }
}

async function readSystemTexts(service: ChatService, botId: string): Promise<string[]> {
    const messages = (await service.listMessages(botId)) ?? [];

    return messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));
}

describe('ChatService turn limits', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let limitStore: LimitStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-limits-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        limitStore = new LimitStore(opened.db);
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('stops a turn at its time limit and names the limit and its value', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new LongTurnRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: 2, usd: null, steps: null } });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([expect.stringContaining('the time limit of 2 minutes')]);
    });

    it('keeps a turn running when no limit is set', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new LongTurnRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE_MS);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);
    });

    it('does not count the time the owner holds the screen', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new LongTurnRunner();
        const screen = new ScreenHolder();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore, screen });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: 1, usd: null, steps: null } });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await service.requestScreen(bot.id, 'I need you to log in.');
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);

        screen.giveToBot();
        await vi.advanceTimersByTimeAsync(MINUTE_MS);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([expect.stringContaining('the time limit of 1 minute')]);
    });

    it('stops a turn at the step limit that the SDK reports, and passes the limit to the runner', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner([{ event: { type: 'turn_limit', limit: 'steps' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: null, usd: null, steps: 3 } });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await finished;

        expect(runner.receivedRequests[0]?.maxSteps)
            .toBe(3);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([expect.stringContaining('the step limit of 3 steps')]);
    });

    it('stops a turn at the spending limit that the SDK reports, and passes the limit to the runner', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner([{ event: { type: 'turn_limit', limit: 'spending' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: null, usd: 0.5, steps: null } });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await finished;

        expect(runner.receivedRequests[0]?.maxSpendUsd)
            .toBe(0.5);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([expect.stringContaining('the spending limit of $0.5')]);
    });

    it('sends no step or spending limit to the runner when none is set', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner([{ event: { type: 'turn_finished' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        expect(runner.receivedRequests[0]?.maxSteps)
            .toBeUndefined();
        expect(runner.receivedRequests[0]?.maxSpendUsd)
            .toBeUndefined();
    });

    it('uses the routines limits for a routine turn and the chat limits for a chat turn', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new FakeAgentRunner([{ event: { type: 'turn_finished' } }, { event: { type: 'turn_finished' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { chat: { minutes: null, usd: null, steps: 5 }, routines: { minutes: null, usd: null, steps: 9 } });

        const chatFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi', 'chat');
        await chatFinished;

        const routineFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Routine', 'routine');
        await routineFinished;

        expect(runner.receivedRequests.map(request => request.maxSteps))
            .toEqual([5, 9]);
    });

    it('counts the review spending against the spending limit and stops the turn when it passes', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new LongTurnRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: null, usd: 0.5, steps: null } });

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        const turnSignal = runner.receivedRequests[0]?.abortSignal;

        service.recordReviewCost(bot.id, 0.3, turnSignal);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);

        service.recordReviewCost(bot.id, 0.3, turnSignal);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([expect.stringContaining('the spending limit of $0.5')]);
    });

    it('drops the review cost of a stopped turn, so the next turn keeps its own spending', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new LongTurnRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, limitStore });

        await limitStore.set(bot.id, { ...NO_LIMITS, chat: { minutes: null, usd: 0.5, steps: null } });

        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'First');
        await runner.started;
        const firstSignal = runner.receivedRequests[0]?.abortSignal;

        await service.stopTurn(bot.id);
        await firstFinished;

        await service.sendMessage(bot.id, 'Second');
        await vi.waitFor(() => {
            expect(runner.receivedRequests)
                .toHaveLength(2);
        });
        const secondSignal = runner.receivedRequests[1]?.abortSignal;

        // The review of the stopped turn returns late with 0.4 of cost. It must not count against the new turn.
        service.recordReviewCost(bot.id, 0.4, firstSignal);
        service.recordReviewCost(bot.id, 0.3, secondSignal);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(await readSystemTexts(service, bot.id))
            .not.toContainEqual(expect.stringContaining('spending limit'));
    });
});
