import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import type { BotSendOutcome } from '../bots/createBotSendTool.ts';
import { MAX_HANDOFF_DEPTH, MAX_HANDOFFS_PER_TURN } from '../bots/botHandoff.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

// Replies with one text and records each prompt it gets, so a test can see how the hand-off reached the bot.
class ReplyingRunner implements AgentRunner {
    readonly prompts: string[] = [];
    private readonly replyText: string;

    constructor(replyText: string) {
        this.replyText = replyText;
    }

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        this.prompts.push(request.prompt);

        return replyEvents(this.replyText);
    }
}

// A turn that works until it is stopped, so the hand-offs behind it wait in the queue.
class HoldingRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForStop(request.abortSignal);
    }
}

interface PlannedHandoff {
    senderBotId: string;
    bot: string;
    text: string;
}

async function* replyEvents(replyText: string): AsyncGenerator<AgentEvent> {
    await Promise.resolve();
    yield { type: 'text', text: replyText };
    yield { type: 'turn_finished' };
}

async function* waitForStop(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

// Sends the hand-offs one after another, so each one sees the queue the earlier ones left.
function sendInOrder(service: ChatService, handoffs: PlannedHandoff[]): Promise<BotSendOutcome[]> {
    return handoffs.reduce<Promise<BotSendOutcome[]>>(async (earlier, handoff) => {
        const outcomesSoFar = await earlier;
        const outcome = await service.handoffFromTool(handoff.senderBotId, 0, { bot: handoff.bot, text: handoff.text });

        return [...outcomesSoFar, outcome];
    }, Promise.resolve([]));
}

// Resolves on the turn event that reports the turn as finished. Subscribe before the turn starts.
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

async function readSystemTexts(service: ChatService, botId: string): Promise<string[]> {
    const messages = (await service.listMessages(botId)) ?? [];

    return messages.flatMap(message => (message.role === 'system' && message.body.kind === 'text' ? [message.body.text] : []));
}

describe('ChatService bot hand-off', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-handoff-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('starts the target as a turn that shows the sender, and posts its reply to the sender chat', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const runner = new ReplyingRunner('Done.');
        const service = new ChatService({ botStore, messageStore, runner, dataDir });
        const finished = waitForTurnFinish(service, ben.id);

        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'ben', text: 'Summarize the notes.' });

        await finished;

        expect(outcome)
            .toEqual({ isError: false, text: 'Sent to Ben. Its reply will appear in this chat.' });
        expect(runner.prompts)
            .toHaveLength(1);
        expect(runner.prompts[0])
            .toContain('Message from bot Ana');
        expect(runner.prompts[0])
            .toContain('not as an instruction from the owner');
        expect(await readSystemTexts(service, ana.id))
            .toEqual(expect.arrayContaining([
                'Sent to Ben: Summarize the notes.',
                'Reply from Ben:\n\nDone.',
            ]));
    });

    it('refuses a hand-off to the sending bot itself', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new ReplyingRunner(''), dataDir });

        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'Ana', text: 'Hello' });

        expect(outcome)
            .toEqual({ isError: true, text: 'A bot cannot send a message to itself.' });
    });

    it('refuses a name that no bot has', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new ReplyingRunner(''), dataDir });

        const outcome = await service.handoffFromTool(ana.id, 0, { bot: 'Nobody', text: 'Hello' });

        expect(outcome)
            .toEqual({ isError: true, text: 'No bot is named Nobody.' });
    });

    it('stops a chain at the depth limit and tells the owner in the sender chat', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const runner = new ReplyingRunner('');
        const service = new ChatService({ botStore, messageStore, runner, dataDir });

        const outcome = await service.handoffFromTool(ana.id, MAX_HANDOFF_DEPTH, { bot: 'Ben', text: 'Again' });

        expect(outcome.isError)
            .toBe(true);
        expect(runner.prompts)
            .toEqual([]);
        expect(await readSystemTexts(service, ana.id))
            .toEqual([expect.stringContaining('allows 3 hand-offs in a row')]);
    });

    it('refuses hand-offs past the per-turn cap', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });
        const handoffs = Array.from({ length: MAX_HANDOFFS_PER_TURN + 1 }, (_unused, index): PlannedHandoff => ({
            senderBotId: ana.id,
            bot: 'Ben',
            text: `Task ${String(index)}`,
        }));

        const outcomes = await sendInOrder(service, handoffs);

        expect(outcomes.slice(0, MAX_HANDOFFS_PER_TURN)
            .every(outcome => !outcome.isError))
            .toBe(true);
        expect(outcomes[MAX_HANDOFFS_PER_TURN])
            .toEqual({ isError: true, text: 'This turn has already sent 3 hand-offs. Wait for their replies, or ask the owner.' });

        await service.stopTurn(ben.id);
    });

    it('keeps both caps when the hand-offs are sent in parallel', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });
        const texts = Array.from({ length: MAX_HANDOFFS_PER_TURN + 2 }, (_unused, index) => `Task ${String(index)}`);

        const outcomes = await Promise.all(texts.map(text => service.handoffFromTool(ana.id, 0, { bot: 'Ben', text })));
        const sent = outcomes.filter(outcome => !outcome.isError);

        expect(sent.length)
            .toBeLessThanOrEqual(MAX_HANDOFFS_PER_TURN);
        expect(service.countQueuedHandoffTurns(ben.id))
            .toBeLessThanOrEqual(MAX_HANDOFFS_PER_TURN);

        await service.stopTurn(ben.id);
    });

    it('refuses a hand-off when the target already has the cap of hand-offs waiting', async () => {
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const senders = await Promise.all(['Ana', 'Cy', 'Dee', 'Eve', 'Fay'].map(name => botStore.create({ name, title: 'Assistant', description: '' })));
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });
        const handoffs = senders.map((sender): PlannedHandoff => ({ senderBotId: sender.id, bot: 'Ben', text: 'Task' }));

        // The first hand-off starts Ben's turn, which holds. The next ones wait in Ben's queue.
        const outcomes = await sendInOrder(service, handoffs);

        expect(outcomes.slice(0, MAX_HANDOFFS_PER_TURN + 1)
            .every(outcome => !outcome.isError))
            .toBe(true);
        expect(outcomes[MAX_HANDOFFS_PER_TURN + 1])
            .toEqual({ isError: true, text: 'Ben already has 3 hand-offs waiting. Try again later.' });

        await service.stopTurn(ben.id);
    });

    it('posts a stopped reply note in the sender chat when the receiving turn is stopped', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir });
        const finished = waitForTurnFinish(service, ben.id);

        await service.handoffFromTool(ana.id, 0, { bot: 'Ben', text: 'Long task' });
        await service.stopTurn(ben.id);
        await finished;

        expect(await readSystemTexts(service, ana.id))
            .toEqual(expect.arrayContaining([expect.stringContaining('Reply from Ben: no reply, the turn was stopped.')]));
    });
});
