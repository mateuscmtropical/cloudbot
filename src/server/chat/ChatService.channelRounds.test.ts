import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, ToolCall, TurnRequest } from '../agent/AgentRunner.ts';
import type { ToolCallReviewer } from '../approvals/ApprovalGate.ts';
import type { ChannelTurnSource } from '../channels/channelRound.ts';
import { BotStore } from '../store/BotStore.ts';
import { ChannelStore } from '../store/ChannelStore.ts';
import type { Channel, ChannelMessage } from '../store/ChannelStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

// Replies with one text and records each prompt, so a test can see what a channel turn was asked.
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

// A turn that works until it is stopped, so the round stays alive and later turns wait behind it.
class HoldingRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForStop(request.abortSignal);
    }
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

const MAX_POLLS = 300;
const POLL_INTERVAL_MS = 10;

// Polls until the check passes, so the background turns can finish before the test looks at the channel.
async function waitFor(check: () => boolean | Promise<boolean>, attempt = 0): Promise<void> {
    if (await check()) {
        return;
    }

    if (attempt >= MAX_POLLS) {
        throw new Error('The condition did not come true in time.');
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    return waitFor(check, attempt + 1);
}

// Asks the approval gate about one tool call, so a test can see what the review was given.
class ReviewingRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return reviewThenFinish(request);
    }
}

async function* reviewThenFinish(request: TurnRequest): AsyncGenerator<AgentEvent> {
    const call: ToolCall = { toolName: 'Bash', input: { command: 'ls' } };

    await request.reviewToolCall?.(call, request.abortSignal);
    yield { type: 'turn_finished' };
}

// Every turn hits the usage limit at once, so the channel round has to end instead of waiting in a queue.
class UsageLimitRunner implements AgentRunner {
    runTurn(): AsyncIterable<AgentEvent> {
        return usageLimitEvents();
    }
}

async function* usageLimitEvents(): AsyncGenerator<AgentEvent> {
    const resetsAt = Date.now() + 60_000;

    await Promise.resolve();
    yield { type: 'rate_limit', status: 'rejected', resetsAt };
    yield { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt };
}

describe('ChatService channel rounds', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let channelStore: ChannelStore;
    let messageStore: MessageStore;
    let channel: Channel;
    let anaId: string;
    let benId: string;
    let carlId: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-rounds-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        channelStore = new ChannelStore(opened.db);
        messageStore = new MessageStore(opened.db);

        const ana = await botStore.create({ name: 'Ana', title: 'Manager', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Helper', description: '' });
        const carl = await botStore.create({ name: 'Carl', title: 'Helper', description: '' });

        anaId = ana.id;
        benId = ben.id;
        carlId = carl.id;
        channel = await channelStore.create({ name: 'Project', managerId: anaId, memberIds: [anaId, benId, carlId] });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    function buildService(runner: AgentRunner): ChatService {
        return new ChatService({ botStore, messageStore, runner, dataDir, channelStore });
    }

    it('answers an owner post in the channel, and keeps the reply out of the bot chat', async () => {
        const runner = new ReplyingRunner('Here is the plan.');
        const service = buildService(runner);

        await service.startChannelRound(channel.id, 'Plan the launch');
        await waitFor(async () => (await channelStore.listRecentMessages(channel.id, 10)).some(post => post.role === 'assistant'));

        const posts = await channelStore.listRecentMessages(channel.id, 10);
        const replyAuthors = posts
            .filter(post => post.role === 'assistant')
            .map(post => post.authorName);
        const anaChat = await messageStore.listByBot(anaId, { limit: 50 });
        const anaReplies = anaChat.filter(message => message.role === 'assistant');
        const firstPrompt = runner.prompts[0] ?? '';

        expect(replyAuthors)
            .toEqual(['Ana']);
        expect(anaReplies)
            .toEqual([]);
        expect(firstPrompt)
            .toContain('The owner just wrote in the channel:\nPlan the launch');
    });

    it('stops a round at six bot turns, counting the manager turn', async () => {
        const service = buildService(new HoldingRunner());
        const roundId = await service.startChannelRound(channel.id, 'Start the work');
        const channelContext: ChannelTurnSource = { channelId: channel.id, roundId: roundId ?? '', depth: 0 };
        const send = (senderId: string, targetName: string): ReturnType<ChatService['handoffFromTool']> => service.handoffFromTool(senderId, 0, { bot: targetName, text: 'Do your part' }, channelContext);

        const first = await send(anaId, 'Ben');
        const second = await send(anaId, 'Carl');
        const third = await send(benId, 'Carl');
        const fourth = await send(carlId, 'Ben');
        const fifth = await send(benId, 'Ana');
        const sixth = await send(carlId, 'Ana');

        expect([first, second, third, fourth, fifth].every(outcome => !outcome.isError))
            .toBe(true);
        expect(sixth.isError)
            .toBe(true);
        expect(sixth.text)
            .toContain('6 bot turns');

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('refuses a hand-off past the chain depth inside a channel turn', async () => {
        const service = buildService(new HoldingRunner());
        const roundId = await service.startChannelRound(channel.id, 'Start the work');
        const deepContext: ChannelTurnSource = { channelId: channel.id, roundId: roundId ?? '', depth: 3 };
        const outcome = await service.handoffFromTool(anaId, 3, { bot: 'Ben', text: 'One more' }, deepContext);

        expect(outcome.isError)
            .toBe(true);
        expect(outcome.text)
            .toContain('A chain allows 3 hand-offs in a row');

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('stops the whole round on stop, and posts one note in the channel', async () => {
        const service = buildService(new HoldingRunner());

        await service.startChannelRound(channel.id, 'Start the work');
        await waitFor(() => service.hasActiveChannelRound(channel.id));

        const stopped = await service.stopChannelRound(channel.id);
        const stoppedAgain = await service.stopChannelRound(channel.id);

        await waitFor(() => !service.hasActiveChannelRound(channel.id));

        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const notes = posts
            .filter(post => post.role === 'system')
            .map(post => post.body);

        expect(stopped)
            .toBe(true);
        expect(stoppedAgain)
            .toBe(false);
        expect(notes)
            .toEqual([{ kind: 'text', text: 'The owner stopped the channel round. Queued replies were dropped.' }]);
    });

    it('drops a queued channel reply with a note when its bot is deleted', async () => {
        const service = buildService(new HoldingRunner());

        await service.startChannelRound(channel.id, '@Ben do the first part');
        await waitFor(() => service.isBusy(benId));
        await service.startChannelRound(channel.id, '@Ben do the second part');

        const outcome = await service.deleteBot(benId);
        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const texts = posts.flatMap(post => (post.body.kind === 'text' ? [post.body.text] : []));

        expect(outcome)
            .toBe('deleted');
        expect(texts)
            .toContain('Ben\'s queued channel reply was dropped before it started: the bot was deleted.');

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('gives the review of a channel turn the channel id, and a bot chat turn none', async () => {
        const reviewer = vi.fn<ToolCallReviewer>(() => Promise.resolve({ decision: 'allow' }));
        const service = new ChatService({ botStore, messageStore, runner: new ReviewingRunner(), dataDir, channelStore, toolCallReviewer: reviewer });

        await service.startChannelRound(channel.id, 'Check the files');
        await waitFor(() => reviewer.mock.calls.length === 1);
        await service.sendMessage(anaId, 'Check the files in my chat');
        await waitFor(() => reviewer.mock.calls.length === 2);

        const [channelReview, chatReview] = reviewer.mock.calls;

        expect(channelReview?.[3])
            .toBe(channel.id);
        expect(chatReview?.[3])
            .toBeUndefined();
    });

    // Adds a plain post to the channel, as a bot would write it, so a test can fill the transcript.
    function appendText(text: string, role: 'user' | 'assistant'): Promise<ChannelMessage> {
        return channelStore.appendMessage(channel.id, {
            authorBotId: undefined,
            authorName: 'Ana',
            authorColor: 'blue',
            authorShape: 'puff',
            role,
            kind: 'text',
            body: { kind: 'text', text },
        });
    }

    it('lets only one of two parallel hand-offs take the last turn of the cap', async () => {
        const service = buildService(new HoldingRunner());
        const roundId = await service.startChannelRound(channel.id, 'Start the work');
        const channelContext: ChannelTurnSource = { channelId: channel.id, roundId: roundId ?? '', depth: 0 };
        const send = (senderId: string, targetName: string): ReturnType<ChatService['handoffFromTool']> => service.handoffFromTool(senderId, 0, { bot: targetName, text: 'Do your part' }, channelContext);

        await send(anaId, 'Ben');
        await send(anaId, 'Carl');
        await send(benId, 'Carl');
        await send(carlId, 'Ben');

        const [lastOne, lastTwo] = await Promise.all([send(benId, 'Ana'), send(carlId, 'Ana')]);
        const outcomes = [lastOne, lastTwo];

        expect(outcomes.filter(outcome => !outcome.isError))
            .toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.isError)
            .map(outcome => outcome.text)
            .join(' '))
            .toContain('6 bot turns');

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('lets a stop that lands during a hand-off end the round, with no bot left running', async () => {
        const service = buildService(new HoldingRunner());
        const roundId = await service.startChannelRound(channel.id, 'Start the work');
        const channelContext: ChannelTurnSource = { channelId: channel.id, roundId: roundId ?? '', depth: 0 };

        await Promise.all([
            service.handoffFromTool(anaId, 0, { bot: 'Ben', text: 'Do your part' }, channelContext),
            service.stopChannelRound(channel.id),
        ]);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));

        expect(service.isBusy(benId))
            .toBe(false);
        expect(service.isBusy(anaId))
            .toBe(false);
    });

    it('ends a channel round that hits the usage limit, with a note, and queues nothing', async () => {
        const service = buildService(new UsageLimitRunner());

        await service.startChannelRound(channel.id, 'Do it');
        await waitFor(async () => (await channelStore.listRecentMessages(channel.id, 20)).some(post => post.body.kind === 'text' && post.body.text.startsWith('The usage limit was reached, so the channel round stopped')));

        const queued = await botStore.listQueuedTurns();
        const anaChat = await messageStore.listByBot(anaId, { limit: 50 });

        expect(queued)
            .toEqual([]);
        expect(anaChat)
            .toEqual([]);
        expect(service.hasActiveChannelRound(channel.id))
            .toBe(false);
    });

    it('drops a member\'s queued channel turns and stops its running reply, with a note, when it leaves', async () => {
        const service = buildService(new HoldingRunner());

        await service.startChannelRound(channel.id, '@Ben do the first part');
        await waitFor(() => service.isBusy(benId));
        await service.startChannelRound(channel.id, '@Ben do the second part');

        await service.dropChannelMember(channel.id, benId);
        await waitFor(() => !service.isBusy(benId) && !service.hasActiveChannelRound(channel.id));

        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const texts = posts.flatMap(post => (post.body.kind === 'text' ? [post.body.text] : []));

        expect(texts)
            .toContain('Ben left the channel, so its queued or running reply was stopped.');
    });

    it('sends a mention to the longest name it starts with', async () => {
        const service = buildService(new ReplyingRunner('On it.'));
        const anaLee = await botStore.create({ name: 'Ana Lee', title: 'Helper', description: '' });

        await channelStore.addMember(channel.id, anaLee.id);
        await service.startChannelRound(channel.id, '@Ana Lee draft the intro');
        await waitFor(async () => (await channelStore.listRecentMessages(channel.id, 20)).some(post => post.role === 'assistant'));

        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const replyAuthors = posts.filter(post => post.role === 'assistant')
            .map(post => post.authorName);

        expect(replyAuthors)
            .toEqual(['Ana Lee']);
    });

    it('keeps the round\'s starting owner post first, even when the newest posts no longer reach back to it', async () => {
        const runner = new ReplyingRunner('Done.');
        const service = buildService(runner);
        const ownerPost = await appendText('Plan the launch', 'user');

        const fillers = Array.from({ length: 35 }, (_, index) => `Filler ${String(index)}`);

        await fillers.reduce(async (previous, text) => {
            await previous;
            await appendText(text, 'assistant');
        }, Promise.resolve());

        await service.startChannelRound(channel.id, 'Plan the launch', ownerPost.id);
        await waitFor(() => runner.prompts.length === 1);

        expect(runner.prompts[0])
            .toContain('Channel so far:\nOwner: Plan the launch\n');
    });

    it('posts a hand-off request in the channel as the sender\'s post, on one line', async () => {
        const service = buildService(new HoldingRunner());
        const roundId = await service.startChannelRound(channel.id, 'Start the work');
        const channelContext: ChannelTurnSource = { channelId: channel.id, roundId: roundId ?? '', depth: 0 };

        await service.handoffFromTool(anaId, 0, { bot: 'Ben', text: 'Draft the intro\nnow' }, channelContext);
        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const request = posts.find(post => post.authorName === 'Ana' && post.body.kind === 'text' && post.body.text === 'Draft the intro now');

        expect(request?.role)
            .toBe('assistant');

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('posts a note in the channel when a channel turn waits for the owner', async () => {
        const reviewer = vi.fn<ToolCallReviewer>(() => Promise.resolve({ decision: 'ask', summary: 'Run ls' }));
        const service = new ChatService({ botStore, messageStore, runner: new ReviewingRunner(), dataDir, channelStore, toolCallReviewer: reviewer });

        await service.startChannelRound(channel.id, 'Check the files');
        await waitFor(async () => (await channelStore.listRecentMessages(channel.id, 20)).some(post => post.body.kind === 'text' && post.body.text === 'Ana is waiting for your answer in its chat.'));

        await service.stopChannelRound(channel.id);
        await waitFor(() => !service.hasActiveChannelRound(channel.id));
    });

    it('ends the rounds of a channel without a note when it is deleted', async () => {
        const service = buildService(new HoldingRunner());

        await service.startChannelRound(channel.id, 'Start the work');
        await waitFor(() => service.hasActiveChannelRound(channel.id));

        const ended = service.endChannelRounds(channel.id);

        await waitFor(() => !service.hasActiveChannelRound(channel.id));

        const posts = await channelStore.listRecentMessages(channel.id, 20);
        const notes = posts.filter(post => post.role === 'system');

        expect(ended)
            .toBe(true);
        expect(notes)
            .toEqual([]);
    });
});
