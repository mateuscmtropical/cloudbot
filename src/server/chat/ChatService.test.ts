import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { buildPng } from '../attachments/testImages.ts';
import { buildSystemPrompt } from '../agent/buildSystemPrompt.ts';
import { PROFILE_SERVER_NAME, SHARE_FILE_TOOL_FULL_NAME, UPDATE_PROFILE_TOOL_FULL_NAME } from '../agent/createProfileToolServer.ts';
import { BrowserControl } from '../desktop/BrowserControl.ts';
import { BROWSER_TOOL_FULL_NAMES } from '../desktop/createBrowserTools.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { ScriptedAgentStep } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService, PendingUploadLimitError, UploadDuringTurnError } from './ChatService.ts';

interface TestSetup {
    service: ChatService;
    runner: FakeAgentRunner;
}

// Resolves on the next turn event that reports the turn as finished. Subscribe before sending.
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

function describeEvent(event: ChatEvent): string {
    if (event.type === 'turn') {
        return `turn:${String(event.isRunning)}`;
    }

    if (event.type === 'textDelta') {
        return `delta:${event.text}`;
    }

    return `message:${event.message.role}:${event.message.body.kind}`;
}

// Like the SDK runner, this one only learns about a stop from the abort event.
// A signal that is already aborted never fires that event again, so the turn would hang.
class AbortOnlyRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForAbort(request.abortSignal);
    }
}

async function* waitForAbort(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

// Plays one script per turn, so each turn can end differently. It uses no timers of its own.
class SequenceRunner implements AgentRunner {
    readonly receivedRequests: TurnRequest[] = [];
    private readonly scripts: AgentEvent[][];

    constructor(scripts: AgentEvent[][]) {
        this.scripts = scripts;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.receivedRequests.push(request);

        const finishedScript: AgentEvent[] = [{ type: 'turn_finished' }];
        const script = this.scripts.shift() ?? finishedScript;

        return replayEvents(script);
    }
}

// A replay has nothing to await. The runner still needs an async iterable.
// eslint-disable-next-line @typescript-eslint/require-await
async function* replayEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

const SESSION_SCRIPT: AgentEvent[] = [{ type: 'session', sessionId: 'session-1' }];
const REPLY_SCRIPT: AgentEvent[] = [{ type: 'text', text: 'Done' }, { type: 'turn_finished' }];
const ONE_MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A rejected limit is followed by the error that ends the turn. The reset time is optional.
function usageLimitScript(resetsAt: number | undefined): AgentEvent[] {
    const resetsAtOption = resetsAt === undefined ? {} : { resetsAt };

    return [
        { type: 'rate_limit', status: 'rejected', ...resetsAtOption },
        { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, ...resetsAtOption },
    ];
}

// Resolves after the given number of turns have reported that they finished.
function waitForTurnFinishes(service: ChatService, botId: string, count: number): Promise<void> {
    let finishedCount = 0;

    return new Promise((resolve) => {
        const unsubscribe = service.subscribe(botId, (event: ChatEvent) => {
            if (event.type === 'turn' && !event.isRunning) {
                finishedCount += 1;

                if (finishedCount === count) {
                    unsubscribe();
                    resolve();
                }
            }
        });
    });
}

async function readSystemTexts(service: ChatService, botId: string): Promise<string[]> {
    const messages = (await service.listMessages(botId)) ?? [];

    return messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));
}

// Resolves when the chat shows that a usage limit wait has started.
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

// The agent cannot start, so the turn ends with an error once it is stopped.
async function* errorAfterAbort(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_error', message: 'Stopped before it started', isUsageLimit: false };
}
describe('ChatService usage limit and queue', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-queue-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('runs the same message again after the reset when the agent never started', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await firstFinished;

        const systemTexts = await readSystemTexts(service, bot.id);

        expect(systemTexts)
            .toContainEqual(expect.stringMatching(/^The usage limit was reached\. CloudBot continues at .+ UTC\.$/));

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 1);

        expect(runner.receivedRequests)
            .toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await retryFinished;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi', 'Hi']);

        service.dispose();
    });

    it('continues the session with "Continue." when the limit hit a session that had started', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([[...SESSION_SCRIPT, ...usageLimitScript(resetsAt)], REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await firstFinished;

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await retryFinished;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi', 'Continue.']);
        expect(runner.receivedRequests[1]?.sessionId)
            .toBe('session-1');

        const storedMessages = (await service.listMessages(bot.id)) ?? [];

        expect(storedMessages.filter(message => message.role === 'user'))
            .toHaveLength(1);

        service.dispose();
    });

    it('waits five minutes when the runner reports a limit without a reset time', async () => {
        vi.useFakeTimers();
        const runner = new SequenceRunner([usageLimitScript(undefined), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await firstFinished;

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync((5 * 60 * 1000) - 1);

        expect(runner.receivedRequests)
            .toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await retryFinished;

        expect(runner.receivedRequests)
            .toHaveLength(2);

        service.dispose();
    });

    it('runs the messages queued during a wait after the retry, in the order they were sent', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt), REPLY_SCRIPT, REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await firstFinished;

        const queuedMessage = await service.sendMessage(bot.id, 'second');

        expect(queuedMessage?.body)
            .toEqual({ kind: 'text', text: 'second', isQueued: true });

        const allFinished = waitForTurnFinishes(service, bot.id, 1);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await allFinished;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi', 'Hi', 'second']);

        service.dispose();
    });

    it('stops the wait and drops the queue when a stop arrives during the wait', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await firstFinished;
        await service.sendMessage(bot.id, 'second');

        const stopFinished = waitForTurnFinish(service, bot.id);

        expect(await service.stopTurn(bot.id))
            .toBe(true);
        await stopFinished;
        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS * 10);

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi']);

        const storedMessages = (await service.listMessages(bot.id)) ?? [];
        const queuedStored = storedMessages.find(message => message.body.kind === 'text' && message.body.text === 'second');

        expect(queuedStored?.body)
            .toEqual({ kind: 'text', text: 'second', isQueued: false });
        expect(await readSystemTexts(service, bot.id))
            .toContain('Stopped. The queued messages were not answered.');

        service.dispose();
    });

    it('resumes the retry and the queued message after a restart', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const firstRunner = new SequenceRunner([usageLimitScript(resetsAt)]);
        const firstService = new ChatService({ botStore, messageStore, runner: firstRunner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForUsageLimitNotice(firstService, bot.id);

        await firstService.sendMessage(bot.id, 'Hi');
        await firstFinished;
        await firstService.sendMessage(bot.id, 'second');
        firstService.dispose();

        // The process restarts: a new service reads the queue and the wait from the database.
        const restartedRunner = new SequenceRunner([REPLY_SCRIPT, REPLY_SCRIPT]);
        const restartedService = new ChatService({ botStore, messageStore, runner: restartedRunner, dataDir });

        await restartedService.resumeQueue();

        const allFinished = waitForTurnFinishes(restartedService, bot.id, 1);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await allFinished;

        expect(firstRunner.receivedRequests)
            .toHaveLength(1);
        expect(restartedRunner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi', 'second']);

        restartedService.dispose();
    });

    it('does not wait when the runner only warns about the limit', async () => {
        const runner = new SequenceRunner([[{ type: 'rate_limit', status: 'allowed_warning' }, ...REPLY_SCRIPT]]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        expect(runner.receivedRequests)
            .toHaveLength(1);
        expect(await readSystemTexts(service, bot.id))
            .toEqual([]);
    });
    it('keeps the bot busy during a usage limit wait, so Stop stays available', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const busyStates: boolean[] = [];

        service.subscribe(bot.id, (event: ChatEvent) => {
            if (event.type === 'turn') {
                busyStates.push(event.isRunning);
            }
        });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await noticeShown;

        expect(service.isBusy(bot.id))
            .toBe(true);
        expect(busyStates)
            .not.toContain(false);

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await retryFinished;

        expect(busyStates.slice(0, -1))
            .not.toContain(false);
        expect(busyStates[busyStates.length - 1])
            .toBe(false);

        service.dispose();
    });

    it('does not show the bot idle between a turn and the queued message behind it', async () => {
        const prompts: string[] = [];
        const firstStarted = Promise.withResolvers<boolean>();
        const runner: AgentRunner = {
            runTurn: (request) => {
                prompts.push(request.prompt);

                if (prompts.length === 1) {
                    firstStarted.resolve(true);

                    return waitForAbort(request.abortSignal);
                }

                return replayEvents(REPLY_SCRIPT);
            },
        };
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const busyStates: boolean[] = [];

        service.subscribe(bot.id, (event: ChatEvent) => {
            if (event.type === 'turn') {
                busyStates.push(event.isRunning);
            }
        });

        await service.sendMessage(bot.id, 'first');
        await firstStarted.promise;
        await service.sendMessage(bot.id, 'second');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        expect(prompts)
            .toEqual(['first', 'second']);
        expect(busyStates.slice(0, -1))
            .not.toContain(false);
        expect(busyStates[busyStates.length - 1])
            .toBe(false);
    });

    it('waits for a usage limit error even when no rejected rate limit event came first', async () => {
        vi.useFakeTimers();
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const errorOnly: AgentEvent[] = [{ type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt }];
        const runner = new SequenceRunner([errorOnly, REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await noticeShown;

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await retryFinished;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['Hi', 'Hi']);

        service.dispose();
    });

    it('retries a past reset time after one minute, not at once', async () => {
        vi.useFakeTimers();
        const runner = new SequenceRunner([usageLimitScript(Date.now() - 60 * 60 * 1000), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await noticeShown;
        expect(await botStore.listUsageWaits())
            .toEqual([{ botId: bot.id, resumeAt: Date.now() + ONE_MINUTE_MS }]);

        expect(runner.receivedRequests)
            .toHaveLength(1);

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS - 1);

        expect(runner.receivedRequests)
            .toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await retryFinished;

        expect(runner.receivedRequests)
            .toHaveLength(2);

        service.dispose();
    });

    it('caps a reset time beyond eight days, so the wait does not fire at once', async () => {
        vi.useFakeTimers();
        const runner = new SequenceRunner([usageLimitScript(Date.now() + 30 * DAY_MS), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await noticeShown;

        expect(await botStore.listUsageWaits())
            .toEqual([{ botId: bot.id, resumeAt: Date.now() + 8 * DAY_MS }]);

        await vi.advanceTimersByTimeAsync(8 * DAY_MS - 1);

        expect(runner.receivedRequests)
            .toHaveLength(1);

        service.dispose();
    });

    it('uses the reset time of the rejected limit over the one copied onto the error', async () => {
        vi.useFakeTimers();
        const rejectedResetsAt = Date.now() + ONE_MINUTE_MS;
        const errorResetsAt = Date.now() + 3 * ONE_MINUTE_MS;
        const limitScript: AgentEvent[] = [
            { type: 'rate_limit', status: 'rejected', resetsAt: rejectedResetsAt },
            { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt: errorResetsAt },
        ];
        const runner = new SequenceRunner([limitScript, REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await noticeShown;

        const retryFinished = waitForTurnFinish(service, bot.id);

        await vi.advanceTimersByTimeAsync(ONE_MINUTE_MS);
        await retryFinished;

        expect(runner.receivedRequests)
            .toHaveLength(2);

        service.dispose();
    });

    it('keeps the files restored by an earlier turn when a later queued turn restores none', async () => {
        const firstStarted = Promise.withResolvers<boolean>();
        let runCount = 0;
        const runner: AgentRunner = {
            runTurn: (request) => {
                runCount += 1;

                if (runCount === 1) {
                    firstStarted.resolve(true);

                    return errorAfterAbort(request.abortSignal);
                }

                return replayEvents(REPLY_SCRIPT);
            },
        };
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File([Buffer.from('notes')], 'notes.txt')]);
        await service.sendMessage(bot.id, 'first');
        await firstStarted.promise;
        await service.sendMessage(bot.id, 'second');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        expect((await service.listPendingUploads(bot.id))?.map(upload => upload.name))
            .toEqual(['notes.txt']);
    });

    it('clears the running state when the queue cannot start the next turn', async () => {
        const prompts: string[] = [];
        const firstStarted = Promise.withResolvers<boolean>();
        const runner: AgentRunner = {
            runTurn: (request) => {
                prompts.push(request.prompt);

                if (prompts.length === 1) {
                    firstStarted.resolve(true);

                    return waitForAbort(request.abortSignal);
                }

                return replayEvents(REPLY_SCRIPT);
            },
        };
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        vi.spyOn(botStore, 'deleteQueuedTurn')
            .mockRejectedValueOnce(new Error('Disk is full'));
        await service.sendMessage(bot.id, 'first');
        await firstStarted.promise;
        await service.sendMessage(bot.id, 'second');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;
        await vi.waitFor(() => {
            expect(service.isBusy(bot.id))
                .toBe(false);
        });

        const thirdFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'third');
        await thirdFinished;

        expect(prompts)
            .toEqual(['first', 'third']);
    });

    it('puts the files of a dropped retry back for the next message when a stop cancels the wait', async () => {
        vi.useFakeTimers();
        const runner = new SequenceRunner([usageLimitScript(Date.now() + ONE_MINUTE_MS)]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File([Buffer.from('notes')], 'notes.txt')]);
        const noticeShown = waitForUsageLimitNotice(service, bot.id);

        await service.sendMessage(bot.id, 'Read this');
        await noticeShown;

        expect(await service.stopTurn(bot.id))
            .toBe(true);
        expect((await service.listPendingUploads(bot.id))?.map(upload => upload.name))
            .toEqual(['notes.txt']);

        service.dispose();
    });
});

describe('ChatService', () => {
    it('sends the agent workspace path and creates nothing under the data folder when an agent user is set', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, agentUser: 'bot' });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        expect(runner.receivedRequests[0]?.workspaceDir)
            .toBe(`/var/lib/cloudbot-workspaces/${bot.id}`);
        expect(existsSync(join(dataDir, 'workspaces')))
            .toBe(false);
    });

    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-chat-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    function buildSetup(script: ScriptedAgentStep[]): TestSetup {
        const runner = new FakeAgentRunner(script);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });

        return { service, runner };
    }

    it('stores the user message and the assistant reply, then finishes the turn', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Hello' }]);
        expect(storedMessages?.map(message => message.role))
            .toEqual(['user', 'assistant']);
    });

    it('publishes the events of a turn in order', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const receivedEvents: ChatEvent[] = [];
        const unsubscribe = service.subscribe(bot.id, (event) => {
            receivedEvents.push(event);
        });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        unsubscribe();

        expect(receivedEvents.map(describeEvent))
            .toEqual(['turn:true', 'message:user:text', 'message:assistant:text', 'turn:false']);
    });

    it('sends the deltas of a text block before its finished message', async () => {
        const { service } = buildSetup([
            { event: { type: 'text_delta', text: 'Hel' } },
            { event: { type: 'text_delta', text: 'lo' } },
            { event: { type: 'text', text: 'Hello' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const receivedEvents: ChatEvent[] = [];
        const unsubscribe = service.subscribe(bot.id, (event) => {
            receivedEvents.push(event);
        });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        unsubscribe();

        expect(receivedEvents.map(describeEvent))
            .toEqual([
                'turn:true',
                'message:user:text',
                'delta:Hel',
                'delta:lo',
                'message:assistant:text',
                'turn:false',
            ]);

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Hello' }]);
    });

    it('keeps the session id from the runner so the next turn resumes it', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'One' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.sessionId)
            .toBeUndefined();
        expect(runner.receivedRequests[1]?.sessionId)
            .toBe('session-1');
        expect(await botStore.getById(bot.id))
            .toMatchObject({ sessionId: 'session-1' });
    });

    it('stores a finished tool call with the name from when it started', async () => {
        const { service } = buildSetup([
            { event: { type: 'tool_started', toolUseId: 'tool-1', toolName: 'Bash', input: { command: 'ls' } } },
            { event: { type: 'tool_finished', toolUseId: 'tool-1', isError: false, output: 'a.txt' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'list files');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.[1]?.body)
            .toEqual({ kind: 'toolActivity', toolName: 'Bash', status: 'done', summary: 'a.txt' });
    });

    it('stores a turn error as a system message', async () => {
        const { service } = buildSetup([
            { event: { type: 'turn_error', message: 'Agent crashed', isUsageLimit: false } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.[1])
            .toMatchObject({ role: 'system', body: { kind: 'text', text: 'Agent crashed' } });
    });

    it('queues a message sent while a turn runs and runs it after that turn', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Reply' }, delayMs: 50 }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'first');

        const queuedMessage = await service.sendMessage(bot.id, 'second');

        expect(queuedMessage?.body)
            .toEqual({ kind: 'text', text: 'second', isQueued: true });

        await finished;

        expect(runner.receivedRequests.map(request => request.prompt))
            .toEqual(['first', 'second']);

        const storedMessages = await service.listMessages(bot.id);
        const secondStored = storedMessages?.find(message => message.body.kind === 'text' && message.body.text === 'second');

        expect(secondStored?.body)
            .toEqual({ kind: 'text', text: 'second', isQueued: false });
    });

    it('stops a running turn and keeps only the messages stored before the stop', async () => {
        const { service } = buildSetup([
            { event: { type: 'text', text: 'Partial' }, delayMs: 60_000 },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        const finished = waitForTurnFinish(service, bot.id);
        const stopResult = await service.stopTurn(bot.id);

        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(stopResult)
            .toBe(true);
        expect(storedMessages?.map(message => message.role))
            .toEqual(['user']);
    });

    it('reports no running turn when stopping an idle bot, and undefined for an unknown bot', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(await service.stopTurn(bot.id))
            .toBe(false);
        expect(await service.stopTurn('missing-bot'))
            .toBeUndefined();
    });

    it('returns undefined when sending to an unknown bot', async () => {
        const { service } = buildSetup([]);

        expect(await service.sendMessage('missing-bot', 'hi'))
            .toBeUndefined();
    });

    it('shows the latest message as the preview on the bot list', async () => {
        const { service } = buildSetup([{ event: { type: 'text', text: 'Hello there' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const bots = await service.listBots();

        expect(bots)
            .toEqual([
                expect.objectContaining({ id: bot.id, name: 'Ana', lastMessagePreview: 'Hello there' }),
            ]);
    });

    it('passes the profile tool, its allowed name and the bot prompt to each turn', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Hello' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: 'Helps with mail' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const turnRequest = runner.receivedRequests[0];

        expect(turnRequest?.mcpServers)
            .toHaveProperty([PROFILE_SERVER_NAME], expect.objectContaining({ type: 'sdk' }));
        expect(turnRequest?.allowedTools)
            .toEqual([UPDATE_PROFILE_TOOL_FULL_NAME, SHARE_FILE_TOOL_FULL_NAME]);
        expect(turnRequest?.systemPrompt)
            .toBe(buildSystemPrompt(bot));
    });

    it('adds the browser tools and the browser paragraph when the bot has a browser', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const browser = new BrowserControl({ devtoolsUrl: 'http://127.0.0.1:9' });
        const service = new ChatService({ botStore, messageStore, runner, dataDir, browser });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const turnRequest = runner.receivedRequests[0];

        expect(turnRequest?.allowedTools)
            .toEqual([UPDATE_PROFILE_TOOL_FULL_NAME, SHARE_FILE_TOOL_FULL_NAME, ...BROWSER_TOOL_FULL_NAMES]);
        expect(turnRequest?.systemPrompt)
            .toBe(buildSystemPrompt(bot, { hasBrowser: true }));
    });

    it('stops a turn without hanging when the stop arrives before the runner starts', async () => {
        const runner = new AbortOnlyRunner();
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        const storedMessages = await service.listMessages(bot.id);

        expect(storedMessages?.map(message => message.role))
            .toEqual(['user']);
    });

    it('starts a fresh session when a resumed session fails before it starts', async () => {
        const resumeRunner = new FakeAgentRunner([
            { event: { type: 'turn_error', message: 'Session not found', isUsageLimit: false } },
        ]);
        const freshRunner = new FakeAgentRunner([
            { event: { type: 'session', sessionId: 'session-2' } },
            { event: { type: 'text', text: 'Fresh reply' } },
        ]);
        const runner: AgentRunner = {
            runTurn: (request: TurnRequest) => (request.sessionId === undefined
                ? freshRunner.runTurn(request)
                : resumeRunner.runTurn(request)),
        };
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.setSessionId(bot.id, 'stale-session');

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const storedMessages = await service.listMessages(bot.id);
        const storedBot = await botStore.getById(bot.id);

        expect(storedMessages?.map(message => message.body))
            .toEqual([{ kind: 'text', text: 'Hi' }, { kind: 'text', text: 'Fresh reply' }]);
        expect(storedBot?.sessionId)
            .toBe('session-2');
    });

    it('hands uploaded files to the next message and stores them on it', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Got it' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const files = [new File([Buffer.from('hello')], 'notes.txt')];
        const summaries = await service.saveUploads(bot.id, files);
        const finished = waitForTurnFinish(service, bot.id);

        expect(summaries)
            .toEqual([{ name: 'notes.txt', mimeType: 'application/octet-stream', sizeBytes: 5 }]);

        const userMessage = await service.sendMessage(bot.id, 'Read this');

        await finished;

        expect(userMessage?.body)
            .toEqual({
                kind: 'text',
                text: 'Read this',
                attachments: [{ name: 'notes.txt', mimeType: 'application/octet-stream', sizeBytes: 5 }],
            });
        expect(runner.receivedRequests[0]?.prompt)
            .toContain(join(dataDir, 'uploads', bot.id));
        expect(runner.receivedRequests[0]?.prompt)
            .toContain('notes.txt');
    });

    it('sends an uploaded image to the agent as image input', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'A cat' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const pngBytes = buildPng(4, 4);
        const files = [new File([pngBytes], 'photo.png')];
        const finished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, files);
        await service.sendMessage(bot.id, 'What is this?');
        await finished;

        expect(runner.receivedRequests[0]?.images)
            .toEqual([{ mediaType: 'image/png', data: pngBytes.toString('base64') }]);
    });

    it('attaches uploads only to the message sent right after them', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'Done' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const files = [new File([Buffer.from('hello')], 'notes.txt')];
        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, files);
        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.prompt)
            .toContain(join(dataDir, 'uploads', bot.id));
        expect(runner.receivedRequests[1]?.prompt)
            .toBe('second');
    });

    it('returns undefined for uploads to an unknown bot', async () => {
        const { service } = buildSetup([]);
        const files = [new File([Buffer.from('hello')], 'notes.txt')];

        expect(await service.saveUploads('missing-bot', files))
            .toBeUndefined();
    });

    it('keeps uploads outside the workspace, in the agent upload root when an agent user is set', () => {
        const agentService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, agentUser: 'bot' });
        const plainService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });

        expect(agentService.uploadDirFor('bot-1'))
            .toBe('/var/lib/cloudbot-uploads/bot-1');
        expect(plainService.uploadDirFor('bot-1'))
            .toBe(join(dataDir, 'uploads', 'bot-1'));
    });

    it('gives the agent the upload folder as an extra directory on every turn', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'Done' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const firstFinished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'first');
        await firstFinished;

        const secondFinished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await secondFinished;

        expect(runner.receivedRequests[0]?.additionalDirectories)
            .toEqual([join(dataDir, 'uploads', bot.id)]);
        expect(runner.receivedRequests[1]?.additionalDirectories)
            .toEqual([join(dataDir, 'uploads', bot.id)]);
    });

    it('removes a file that was never sent after one day and keeps a newer one', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const dayMs = 24 * 60 * 60 * 1000;

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);

        const keptEarly = await service.cleanUploads(Date.now() + dayMs / 2);
        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(keptEarly)
            .toEqual([]);
        expect(await readdir(uploadDir))
            .toHaveLength(1);

        const removed = await service.cleanUploads(Date.now() + dayMs * 2);

        expect(removed)
            .toHaveLength(1);
        expect(await readdir(uploadDir))
            .toEqual([]);
        expect(await service.listPendingUploads(bot.id))
            .toEqual([]);
    });

    it('removes a sent file after the retention time and not before', async () => {
        const { service } = buildSetup([{ event: { type: 'session', sessionId: 'session-1' } }, { event: { type: 'text', text: 'Done' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const dayMs = 24 * 60 * 60 * 1000;
        const finished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'read it');
        await finished;

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await service.cleanUploads(Date.now() + dayMs * 10))
            .toEqual([]);
        expect(await readdir(uploadDir))
            .toHaveLength(1);
        expect(await service.cleanUploads(Date.now() + dayMs * 31))
            .toHaveLength(1);
        expect(await readdir(uploadDir))
            .toEqual([]);
    });

    it('removes shared copies after the retention time and keeps recent ones', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const dayMs = 24 * 60 * 60 * 1000;
        const workspace = service.workspaceFor(bot.id);

        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'report.txt'), 'report');
        await service.shareFile(bot.id, 'report.txt');

        const shareDir = service.shareDirFor(bot.id);

        expect(await service.cleanUploads(Date.now() + dayMs * 10))
            .toEqual([]);
        expect(await readdir(shareDir))
            .toHaveLength(1);

        const removed = await service.cleanUploads(Date.now() + dayMs * 31);

        expect(removed)
            .toHaveLength(1);
        expect(await readdir(shareDir))
            .toEqual([]);
    });

    it('keeps a shared copy that is newer than the retention time even when an older one goes', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const dayMs = 24 * 60 * 60 * 1000;
        const workspace = service.workspaceFor(bot.id);

        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'a.txt'), 'a');
        await writeFile(join(workspace, 'b.txt'), 'b');
        await service.shareFile(bot.id, 'a.txt');
        await service.shareFile(bot.id, 'b.txt');

        const shareDir = service.shareDirFor(bot.id);
        const [oldName] = await readdir(shareDir);
        const oldTime = new Date(Date.now() - dayMs * 40);

        await utimes(join(shareDir, oldName ?? ''), oldTime, oldTime);
        await service.cleanUploads();

        const remaining = await readdir(shareDir);

        expect(remaining)
            .toHaveLength(1);
        expect(remaining)
            .not.toContain(oldName);
    });

    it('leaves no copy when the message of a shared file cannot be saved', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const workspace = service.workspaceFor(bot.id);

        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, 'report.txt'), 'report');
        vi.spyOn(messageStore, 'add')
            .mockRejectedValueOnce(new Error('disk full'));

        await expect(service.shareFile(bot.id, 'report.txt'))
            .rejects.toThrow('disk full');
        expect(await readdir(service.shareDirFor(bot.id)))
            .toEqual([]);
    });

    it('keeps the files of a turn that is still running, however old they are', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const dayMs = 24 * 60 * 60 * 1000;

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'read it');

        expect(await service.cleanUploads(Date.now() + dayMs * 90))
            .toEqual([]);
        expect(await readdir(join(dataDir, 'uploads', bot.id)))
            .toHaveLength(1);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;
    });

    it('builds the image from the bytes kept in memory, even when the file is gone from disk', async () => {
        const { service, runner } = buildSetup([{ event: { type: 'text', text: 'A cat' } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const pngBytes = buildPng(4, 4);

        await service.saveUploads(bot.id, [new File([pngBytes], 'photo.png')]);

        const uploadDir = join(dataDir, 'uploads', bot.id);
        const [storedName] = await readdir(uploadDir);
        const storedPath = join(uploadDir, storedName ?? '');

        await rm(storedPath);

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'What is this?');
        await finished;

        expect(runner.receivedRequests[0]?.images)
            .toEqual([{ mediaType: 'image/png', data: pngBytes.toString('base64') }]);
    });

    it('refuses an upload that would give the next message more than 10 files', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const tenFiles = Array.from({ length: 10 }, (_value, index) => new File(['x'], `file-${String(index)}.txt`));

        await service.saveUploads(bot.id, tenFiles);

        await expect(service.saveUploads(bot.id, [new File(['x'], 'extra.txt')]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toHaveLength(10);
    });

    it('refuses an upload that would give the next message more than 20 MB and keeps nothing', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const largeFile = new File([Buffer.alloc(21 * 1024 * 1024)], 'large.bin');

        await expect(service.saveUploads(bot.id, [largeFile]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toEqual([]);
    });

    it('keeps the files of a message that failed to save and refuses the upload that came in meanwhile', async () => {
        const { service, runner } = buildSetup([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'Done' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['a'], 'first.txt')]);
        const addSpy = vi.spyOn(messageStore, 'add');

        addSpy.mockImplementationOnce(async () => {
            await expect(service.saveUploads(bot.id, [new File(['b'], 'second.txt')]))
                .rejects.toBeInstanceOf(UploadDuringTurnError);

            throw new Error('database is busy');
        });

        await expect(service.sendMessage(bot.id, 'first'))
            .rejects.toThrow('database is busy');

        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'second');
        await finished;

        expect(runner.receivedRequests[0]?.prompt)
            .toContain('first.txt');
        expect(runner.receivedRequests[0]?.prompt)
            .not.toContain('second.txt');
    });

    it('refuses uploads while a turn runs and keeps the queue empty', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.sendMessage(bot.id, 'Hi');

        await expect(service.saveUploads(bot.id, [new File(['x'], 'late.txt')]))
            .rejects.toBeInstanceOf(UploadDuringTurnError);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        expect(await service.listPendingUploads(bot.id))
            .toEqual([]);
    });

    it('removes the files of an upload that a turn starts over while they are written', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        // The file is read after the first running check and after the folder exists, so a turn started
        // by that read is the one the second check has to catch.
        const lateFile = new File(['a'], 'late.txt');
        const readBytes = lateFile.arrayBuffer.bind(lateFile);

        vi.spyOn(lateFile, 'arrayBuffer')
            .mockImplementationOnce(async () => {
                await service.sendMessage(bot.id, 'Started first');

                return readBytes();
            });

        await expect(service.saveUploads(bot.id, [lateFile]))
            .rejects.toBeInstanceOf(UploadDuringTurnError);

        const uploadDir = join(dataDir, 'uploads', bot.id);

        expect(await readdir(uploadDir))
            .toEqual([]);

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;
    });

    it('puts the uploads back for the next message when the agent never starts', async () => {
        const { service } = buildSetup([{ event: { type: 'turn_error', message: 'Could not start the agent.', isUsageLimit: false } }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'Read this');
        await finished;

        const queued = await service.listPendingUploads(bot.id);

        expect(queued?.map(upload => upload.name))
            .toEqual(['notes.txt']);
    });

    it('puts the uploads back when a stop arrives before the agent sends its session', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new AbortOnlyRunner(), dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['hello'], 'notes.txt')]);
        await service.sendMessage(bot.id, 'Read this');

        const finished = waitForTurnFinish(service, bot.id);

        await service.stopTurn(bot.id);
        await finished;

        const queued = await service.listPendingUploads(bot.id);

        expect(queued?.map(upload => upload.name))
            .toEqual(['notes.txt']);
    });

    it('lists the waiting files and removes one of them together with its file', async () => {
        const { service } = buildSetup([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.saveUploads(bot.id, [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);

        const queued = await service.listPendingUploads(bot.id);
        const firstId = queued?.[0]?.id ?? '';

        expect(queued?.map(upload => upload.name))
            .toEqual(['a.txt', 'b.txt']);
        expect(await service.removePendingUpload(bot.id, firstId))
            .toBe(true);
        expect(await service.removePendingUpload(bot.id, firstId))
            .toBe(false);

        const remaining = await service.listPendingUploads(bot.id);

        expect(remaining?.map(upload => upload.name))
            .toEqual(['b.txt']);
        expect(await readdir(join(dataDir, 'uploads', bot.id)))
            .toHaveLength(1);
        expect(await service.listPendingUploads('missing-bot'))
            .toBeUndefined();
    });

    it('caps the next message at the configured upload size instead of a fixed 20 MB', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, maxUploadBytes: 1024 });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const twoKilobytes = new File([Buffer.alloc(2048)], 'big.bin');

        await expect(service.saveUploads(bot.id, [twoKilobytes]))
            .rejects.toBeInstanceOf(PendingUploadLimitError);
    });

    it('keeps the workspace under the one path the service exposes', () => {
        const { service } = buildSetup([]);

        expect(service.workspaceFor('bot-1'))
            .toBe(join(dataDir, 'workspaces', 'bot-1'));
    });

    it('puts the workspace under the agent workspace root when the agent runs as its own user', () => {
        const agentService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, agentUser: 'bot' });

        expect(agentService.workspaceFor('bot-1'))
            .toBe('/var/lib/cloudbot-workspaces/bot-1');
    });
});
