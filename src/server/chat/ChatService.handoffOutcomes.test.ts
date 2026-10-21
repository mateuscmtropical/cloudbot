import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { SetupConversation } from '../setup/SetupConversation.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';

const ONE_MINUTE_MS = 60_000;
const REPLY_SCRIPT: AgentEvent[] = [{ type: 'text', text: 'Done' }, { type: 'turn_finished' }];

// Plays one script per turn, in order. A turn with no script left ends at once.
class SequenceRunner implements AgentRunner {
    readonly prompts: string[] = [];
    private readonly scripts: AgentEvent[][];

    constructor(scripts: AgentEvent[][]) {
        this.scripts = [...scripts];
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.prompts.push(request.prompt);

        return scriptEvents(this.scripts.shift() ?? []);
    }
}

// A turn that always fails with an error that is not a usage limit.
class FailingRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return scriptEvents([{ type: 'turn_error', message: 'Something broke', isUsageLimit: false }]);
    }
}

// A turn that works until it is stopped, so the hand-offs behind it wait in the queue.
class HoldingRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForStop(request.abortSignal);
    }
}

async function* scriptEvents(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    await Promise.resolve();
    yield* events;
}

async function* waitForStop(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

// A rejected limit is followed by the error that ends the turn, so the turn waits for the reset.
function usageLimitScript(resetsAt: number): AgentEvent[] {
    return [
        { type: 'rate_limit', status: 'rejected', resetsAt },
        { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt },
    ];
}

// Resolves after the given number of turns of the bot have reported that they finished.
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

async function readSystemTexts(service: ChatService, botId: string): Promise<string[]> {
    const messages = (await service.listMessages(botId)) ?? [];

    return messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));
}

// The deleting set is private to the service. Marking a bot there is how a test reaches the delete race.
function markDeleting(service: ChatService, botId: string): void {
    (service as unknown as { deletingBots: Set<string> }).deletingBots.add(botId);
}

describe('ChatService bot hand-off outcomes', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-handoff-outcomes-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        vi.useRealTimers();
        opened.close();
        await rm(dataDir, { recursive: true, force: true });
    });

    it('reports a hand-off once, from the message it started with, after a usage limit wait', async () => {
        vi.useFakeTimers();
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt), REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const notice = waitForUsageLimitNotice(service, ben.id);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Long task' });
        await notice;

        // The turn that hit the limit posts no reply yet, since it is not over.
        expect((await readSystemTexts(service, ana.id)).filter(text => text.startsWith('Reply from')))
            .toEqual([]);

        const secondFinish = waitForTurnFinishes(service, ben.id, 1);

        await vi.advanceTimersByTimeAsync(2 * ONE_MINUTE_MS);
        await secondFinish;

        expect((await readSystemTexts(service, ana.id)).filter(text => text.startsWith('Reply from')))
            .toEqual(['Reply from Ben:\n\nDone']);
    });

    it('stops a hand-off waiting for a usage limit and tells the sender it was dropped', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const resetsAt = Date.now() + ONE_MINUTE_MS;
        const runner = new SequenceRunner([usageLimitScript(resetsAt)]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const notice = waitForUsageLimitNotice(service, ben.id);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Long task' });
        await notice;
        await service.stopTurn(ben.id);

        expect(await readSystemTexts(service, ana.id))
            .toEqual(expect.arrayContaining(['The hand-off to Ben was dropped before it started: the owner stopped the bot.']));
    });

    it('reports a failed hand-off turn as failed, not as stopped', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new FailingRunner(), dataDir });
        const finished = waitForTurnFinishes(service, ben.id, 1);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });
        await finished;

        expect(await readSystemTexts(service, ana.id))
            .toEqual(expect.arrayContaining(['Reply from Ben: no reply, the turn failed.']));
    });

    it('tells the sender that its queued hand-offs were dropped when the target is deleted', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const cy = await botStore.create({ name: 'Cy', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Running task' });
        await service.handoffFromTool(cy.id, 0, { bot: 'Ben', text: 'Waiting task' });
        await service.deleteBot(ben.id);

        expect(await readSystemTexts(service, cy.id))
            .toEqual(expect.arrayContaining(['The hand-off to Ben was dropped before it started: the bot was deleted.']));
    });

    it('posts no reply to a sender that is being deleted', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });
        const finished = waitForTurnFinishes(service, ben.id, 1);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });
        markDeleting(service, ana.id);
        await service.stopTurn(ben.id);
        await finished;

        expect(await readSystemTexts(service, ana.id))
            .not.toEqual(expect.arrayContaining([expect.stringContaining('Reply from Ben')]));
    });

    it('refuses a hand-off while the target is being deleted', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new SequenceRunner([]), dataDir });

        markDeleting(service, ben.id);
        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });

        expect(outcome)
            .toEqual({ isError: true, text: 'The hand-off to Ben was not sent: the bot is being deleted.' });
    });

    it('refuses a hand-off to a bot that no longer exists', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new SequenceRunner([]), dataDir });

        await botStore.delete(ben.id);
        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });

        expect(outcome)
            .toEqual({ isError: true, text: 'No bot is named Ben.' });
    });

    it('refuses a hand-off to a bot whose Claude setup is not done', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const runner = new SequenceRunner([]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const setup = { isDone: () => false, isStarting: () => false, isSetupBot: () => false };

        service.setSetup(setup as unknown as SetupConversation);
        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });

        expect(outcome)
            .toEqual({ isError: true, text: 'The hand-off to Ben was not sent: the bot is not set up to take messages yet.' });
        expect(runner.prompts)
            .toEqual([]);
    });

    it('keeps the owner files staged for the target out of a hand-off', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const runner = new SequenceRunner([REPLY_SCRIPT]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir });

        await service.saveUploads(ben.id, [new File(['hello'], 'notes.txt', { type: 'text/plain' })]);
        const finished = waitForTurnFinishes(service, ben.id, 1);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Task' });
        await finished;

        expect(runner.prompts[0])
            .not.toContain('notes.txt');
        expect(await service.listPendingUploads(ben.id))
            .toHaveLength(1);
    });
});
