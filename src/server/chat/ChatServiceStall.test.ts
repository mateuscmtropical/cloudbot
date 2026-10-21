import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { ScreenHolder } from '../desktop/ScreenHolder.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { STALL_MESSAGE, STALL_MS } from './StallWatchdog.ts';

const MINUTE_MS = 60_000;

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

function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Sends one event after each gap, then waits until it is stopped. No gaps means it sends nothing at all.
async function* pulse(gapsMs: number[], pulseEvent: AgentEvent, abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    const [gap, ...restGaps] = gapsMs;

    if (gap === undefined) {
        yield* waitForAbort(abortSignal);

        return;
    }

    await pause(gap);

    if (abortSignal.aborted) {
        return;
    }

    yield pulseEvent;
    yield* pulse(restGaps, pulseEvent, abortSignal);
}

class GappedRunner implements AgentRunner {
    readonly started: Promise<void>;
    private readonly gapsMs: number[];
    private readonly pulseEvent: AgentEvent;
    private markStarted: () => void = () => undefined;

    constructor(gapsMs: number[], pulseEvent: AgentEvent = { type: 'text_delta', text: 'working' }) {
        this.gapsMs = gapsMs;
        this.pulseEvent = pulseEvent;
        this.started = new Promise<void>((resolve) => {
            this.markStarted = resolve;
        });
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.markStarted();

        return pulse(this.gapsMs, this.pulseEvent, request.abortSignal);
    }
}

// Finishes at once, with no timer, so a finished turn can be checked for leftover timers.
class InstantRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return (async function* finishNow(): AsyncGenerator<AgentEvent> {
            await Promise.resolve();
            yield { type: 'turn_finished' };
        })();
    }
}

// Never sends an event and ignores its abort signal, like a hung tool.
class HungRunner implements AgentRunner {
    readonly started: Promise<void>;
    private markStarted: () => void = () => undefined;

    constructor() {
        this.started = new Promise<void>((resolve) => {
            this.markStarted = resolve;
        });
    }

    runTurn(): AsyncIterable<AgentEvent> {
        this.markStarted();

        return (async function* hang(): AsyncGenerator<AgentEvent> {
            await new Promise<void>(() => undefined);
            yield { type: 'turn_finished' };
        })();
    }
}

async function readSystemTexts(service: ChatService, botId: string): Promise<string[]> {
    const messages = (await service.listMessages(botId)) ?? [];

    return messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));
}

describe('ChatService stall watch', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-stall-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('stops a turn that sends nothing for 10 minutes, and the chat says why', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new GappedRunner([]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(STALL_MS);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([STALL_MESSAGE]);
    });

    it('keeps a turn alive while it sends events, and counts 10 minutes from the last one', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new GappedRunner([6 * MINUTE_MS, 6 * MINUTE_MS, 6 * MINUTE_MS]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(6 * MINUTE_MS);
        await vi.advanceTimersByTimeAsync(6 * MINUTE_MS);
        await vi.advanceTimersByTimeAsync(6 * MINUTE_MS);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);

        await vi.advanceTimersByTimeAsync(STALL_MS);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([STALL_MESSAGE]);
    });

    it('does not stop a turn that gets only activity events for 15 minutes', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new GappedRunner([5 * MINUTE_MS, 5 * MINUTE_MS, 5 * MINUTE_MS], { type: 'activity' });
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);

        await vi.advanceTimersByTimeAsync(STALL_MS);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([STALL_MESSAGE]);
    });

    it('does not count the time the owner holds the screen', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new GappedRunner([]);
        const screen = new ScreenHolder();
        const service = new ChatService({ botStore, messageStore, runner, dataDir, screen });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await service.requestScreen(bot.id, 'I need you to log in.');
        await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

        expect(service.isTurnRunning(bot.id))
            .toBe(true);
        expect(await readSystemTexts(service, bot.id))
            .not.toContain(STALL_MESSAGE);

        screen.giveToBot();
        await vi.advanceTimersByTimeAsync(STALL_MS - 1);

        expect(await readSystemTexts(service, bot.id))
            .not.toContain(STALL_MESSAGE);

        await vi.advanceTimersByTimeAsync(1);
        await finished;

        expect(await readSystemTexts(service, bot.id))
            .toEqual([STALL_MESSAGE]);
    });

    it('leaves no timer behind when a turn finishes', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new InstantRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        expect(vi.getTimerCount())
            .toBe(0);

        await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);
    });

    it('gives no second message when Stop comes before the stall fires', async () => {
        vi.useFakeTimers();
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new HungRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir });

        await service.sendMessage(bot.id, 'Work on this');
        await runner.started;
        await vi.advanceTimersByTimeAsync(STALL_MS - MINUTE_MS);

        expect(await service.stopTurn(bot.id))
            .toBe(true);

        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);
    });
});
