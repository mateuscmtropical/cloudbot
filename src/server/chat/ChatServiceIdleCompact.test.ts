import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import type { ProviderToolDependencies } from '../providers/createProviderTools.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';

// Same delay as IDLE_COMPACT_DELAY_MS in ChatService, so a test can wait exactly until the compaction is due.
const COMPACT_DELAY_MS = 4 * 60 * 1000;
// Same threshold as IDLE_COMPACT_MIN_CONTEXT_TOKENS in ChatService.
const LARGE_CONTEXT_TOKENS = 40_000;
const QUIET_REPLY = 'NOTHING_TO_REPORT';
const FLUSH_REPLY: AgentEvent[] = [{ type: 'text', text: QUIET_REPLY }, { type: 'turn_finished' }];

// Resolves when the next turn of the bot ends. Subscribe before the turn can end.
function waitForTurnEnd(service: ChatService, botId: string): Promise<void> {
    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'turn' && !event.isRunning) {
                unsubscribe();
                resolve();
            }
        });
    });
}

// A replay has nothing to await. Plain generators keep the runner free of timers, so fake timers never hold a turn.
// eslint-disable-next-line @typescript-eslint/require-await
async function* replayEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

function replyEvents(text: string, contextTokens?: number): AgentEvent[] {
    return [
        { type: 'session', sessionId: 'session-1' },
        { type: 'text', text },
        contextTokens === undefined ? { type: 'turn_finished' } : { type: 'turn_finished', contextTokens },
    ];
}

// Each turn replays the next script. A compaction is recorded apart from the turns, and its test can fail it or look at the bot first.
class IdleRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    readonly compactRequests: TurnRequest[] = [];
    compactError: Error | undefined = undefined;
    onCompact: (() => void) | undefined = undefined;
    private readonly scripts: AgentEvent[][];

    constructor(scripts: AgentEvent[][]) {
        this.scripts = scripts;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        const script = this.scripts[this.receivedRequests.length] ?? [];

        this.receivedRequests.push(request);

        return replayEvents(script);
    }

    compactSession(request: TurnRequest): Promise<void> {
        this.compactRequests.push(request);
        this.onCompact?.();

        if (this.compactError !== undefined) {
            return Promise.reject(this.compactError);
        }

        return Promise.resolve();
    }
}

describe('ChatService idle compaction', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let services: ChatService[];

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-idle-compact-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        services = [];
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(async () => {
        services.forEach((service) => {
            service.dispose();
        });
        vi.useRealTimers();
        vi.restoreAllMocks();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    function createService(runner: IdleRunner, providerTools?: ProviderToolDependencies): ChatService {
        const service = new ChatService({ botStore, messageStore, runner, dataDir, providerTools });

        services.push(service);

        return service;
    }

    async function sendAndWait(service: ChatService, botId: string, text: string): Promise<void> {
        const finished = waitForTurnEnd(service, botId);

        await service.sendMessage(botId, text);
        await finished;
    }

    // Moves the clock and waits for the turn that the clock started, which is the memory flush.
    async function advanceAndWaitForTurn(service: ChatService, botId: string, ms: number): Promise<void> {
        const finished = waitForTurnEnd(service, botId);

        await vi.advanceTimersByTimeAsync(ms);
        await finished;
    }

    it('runs a quiet memory flush, then compacts the session while the bot is busy', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS), FLUSH_REPLY]);
        const service = createService(runner);
        const busyDuringCompaction: boolean[] = [];

        runner.onCompact = () => {
            busyDuringCompaction.push(service.isBusy(bot.id));
        };

        await sendAndWait(service, bot.id, 'Hello');
        await advanceAndWaitForTurn(service, bot.id, COMPACT_DELAY_MS);

        const flushRequest = runner.receivedRequests[1];

        expect(flushRequest?.prompt)
            .toContain(QUIET_REPLY);
        expect(flushRequest?.prompt)
            .toContain('MEMORY.md');
        expect(flushRequest?.sessionId)
            .toBe('session-1');
        expect(runner.compactRequests.map(request => request.sessionId))
            .toEqual(['session-1']);
        expect(busyDuringCompaction)
            .toEqual([true]);

        const stored = await messageStore.listByBot(bot.id, { limit: 10 });

        expect(stored)
            .toHaveLength(2);
        expect(stored.map(message => message.role))
            .toEqual(expect.arrayContaining(['user', 'assistant']));
    });

    it('does not flush a session under 40k tokens', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS - 1)]);
        const service = createService(runner);

        await sendAndWait(service, bot.id, 'Hello');
        await vi.advanceTimersByTimeAsync(COMPACT_DELAY_MS);

        expect(runner.receivedRequests)
            .toHaveLength(1);
        expect(runner.compactRequests)
            .toHaveLength(0);
    });

    it('cancels the compaction when a new message arrives before the delay ends', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS), replyEvents('Sure.')]);
        const service = createService(runner);

        await sendAndWait(service, bot.id, 'Hello');
        await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
        await sendAndWait(service, bot.id, 'Again');
        await vi.advanceTimersByTimeAsync(COMPACT_DELAY_MS);

        expect(runner.receivedRequests)
            .toHaveLength(2);
        expect(runner.compactRequests)
            .toHaveLength(0);
    });

    it('skips the compaction for a provider without a compact command', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS)]);
        const providerTools: ProviderToolDependencies = {
            available: ['gemini'],
            connected: () => Promise.resolve(['gemini']),
            providerFor: () => Promise.resolve('gemini'),
            setProvider: () => Promise.resolve(),
            offerProviders: () => Promise.resolve(),
        };
        const service = createService(runner, providerTools);

        await sendAndWait(service, bot.id, 'Hello');
        await vi.advanceTimersByTimeAsync(COMPACT_DELAY_MS);

        expect(runner.receivedRequests)
            .toHaveLength(1);
        expect(runner.compactRequests)
            .toHaveLength(0);
    });

    it('logs a failed compaction and shows nothing in the chat', async () => {
        const consoleError = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS), FLUSH_REPLY]);
        const service = createService(runner);
        const refusal = new Error('The CLI refused the compaction.');

        runner.compactError = refusal;

        await sendAndWait(service, bot.id, 'Hello');
        await advanceAndWaitForTurn(service, bot.id, COMPACT_DELAY_MS);

        expect(consoleError)
            .toHaveBeenCalledWith('Could not compact the session of a bot.', refusal);

        const stored = await messageStore.listByBot(bot.id, { limit: 10 });

        expect(stored.map(message => message.role))
            .toEqual(expect.arrayContaining(['user', 'assistant']));
        expect(stored)
            .toHaveLength(2);
    });

    it('skips the compaction when the memory flush hits a usage limit', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const limitedFlush: AgentEvent[] = [
            { type: 'rate_limit', status: 'rejected' },
            { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true },
        ];
        const runner = new IdleRunner([replyEvents('Done.', LARGE_CONTEXT_TOKENS), limitedFlush]);
        const service = createService(runner);

        await sendAndWait(service, bot.id, 'Hello');
        await advanceAndWaitForTurn(service, bot.id, COMPACT_DELAY_MS);

        expect(runner.compactRequests)
            .toHaveLength(0);

        const stored = await messageStore.listByBot(bot.id, { limit: 10 });

        expect(stored)
            .toHaveLength(2);
        expect(stored.map(message => message.role))
            .toEqual(expect.arrayContaining(['user', 'assistant']));
    });
});
