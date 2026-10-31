import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { ScreenHolder } from '../desktop/ScreenHolder.ts';
import { NOTIFICATIONS_DISABLE_TOOL_FULL_NAME, NOTIFICATIONS_ENABLE_TOOL_FULL_NAME } from '../push/createNotificationTools.ts';
import type { OwnerNotice } from '../push/PushNotifier.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

// A turn that works until it is stopped, so a test can act while the bot is busy.
class HoldingRunner implements AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return waitForStop(request.abortSignal);
    }
}

// A turn that calls one of its CloudBot tools and then replies, like a model would.
class ToolCallingRunner implements AgentRunner {
    constructor(
        private readonly toolName: string,
        private readonly toolInput: Record<string, unknown>,
        private readonly replyText: string,
    ) {}

    runTurn(request: TurnRequest): AsyncIterable<AgentEvent> {
        return this.callThenReply(request);
    }

    private async* callThenReply(request: TurnRequest): AsyncGenerator<AgentEvent> {
        const calledTool = request.tools?.find(candidate => candidate.name === this.toolName);

        await calledTool?.handler(this.toolInput, {});

        yield { type: 'text', text: this.replyText };
        yield { type: 'turn_finished' };
    }
}

async function* waitForStop(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

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

// The notice is sent in the background, so a test waits until the fake has seen the expected number.
async function waitForNotices(notices: OwnerNotice[], count: number): Promise<void> {
    await vi.waitFor(() => {
        expect(notices)
            .toHaveLength(count);
    });
}

describe('ChatService notifications', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let notices: OwnerNotice[];
    let notifyOwner: (notice: OwnerNotice) => Promise<void>;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-notify-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        notices = [];
        notifyOwner = (notice) => {
            notices.push(notice);

            return Promise.resolve();
        };
    });

    afterEach(async () => {
        opened.close();
        vi.restoreAllMocks();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('notifies the owner when a turn finishes, with the first line of the reply and the newest message', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: '## **Sent** the weekly report\n\nThe details follow.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        await waitForNotices(notices, 1);

        const messages = await service.listMessages(bot.id);
        const newest = (messages ?? []).at(-1);

        expect(notices[0])
            .toEqual({ kind: 'done', botId: bot.id, botName: 'Ana', messageId: newest?.id, body: 'Sent the weekly report' });
    });

    it('uses the line the bot set with notification_text', async () => {
        const runner = new ToolCallingRunner('notification_text', { text: 'Daily summary is ready' }, 'Here is the summary.');
        const service = new ChatService({ botStore, messageStore, runner, dataDir, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;
        await waitForNotices(notices, 1);

        expect(notices[0]?.body)
            .toBe('Daily summary is ready');
    });

    it('does not notify when the owner stops the turn', async () => {
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await service.stopTurn(bot.id);
        await finished;
        // Gives a wrongly started notice time to arrive.
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(notices)
            .toEqual([]);
    });

    it('does not notify when a webhook started the turn', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Handled.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Payload from an outside service', 'webhook');
        await finished;
        // Gives a wrongly started notice time to arrive.
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(notices)
            .toEqual([]);
    });

    it('still notifies for a turn that a routine started', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Done.' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Daily check', 'routine');
        await finished;
        await waitForNotices(notices, 1);

        expect(notices[0]?.kind)
            .toBe('done');
    });

    it('notifies the owner when an approval waits, with the id of the card', async () => {
        const toolCallReviewer = vi.fn(() => Promise.resolve({ decision: 'allow' as const }));
        const service = new ChatService({ botStore, messageStore, runner: new HoldingRunner(), dataDir, notifyOwner, toolCallReviewer });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');

        const approval = service.requestOwnerApproval(bot.id, 'Push to main', undefined);

        await waitForNotices(notices, 1);

        const card = ((await service.listMessages(bot.id)) ?? []).find(message => message.body.kind === 'choice');

        expect(notices[0])
            .toEqual({ kind: 'approval', botId: bot.id, botName: 'Ana', messageId: card?.id });

        await service.stopTurn(bot.id);
        await approval;
        await finished;
    });

    it('notifies the owner when the bot hands over its screen', async () => {
        const screen = new ScreenHolder();
        const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, screen, notifyOwner });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await service.requestScreen(bot.id, 'A check I cannot pass.');
        await waitForNotices(notices, 1);

        const note = ((await service.listMessages(bot.id)) ?? []).at(-1);

        expect(notices[0])
            .toEqual({ kind: 'screen', botId: bot.id, botName: 'Ana', messageId: note?.id });
    });

    it('keeps the chat working when sending a notification fails', async () => {
        const errorLog = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const failing = (): Promise<void> => Promise.reject(new Error('push service down'));
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const service = new ChatService({ botStore, messageStore, runner, dataDir, notifyOwner: failing });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        await vi.waitFor(() => {
            expect(errorLog)
                .toHaveBeenCalledWith('Could not send a notification.');
        });
    });

    it('offers the notification tool only when notifications can be sent', async () => {
        const withNotices = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const withoutNotices = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const withService = new ChatService({ botStore, messageStore, runner: withNotices, dataDir, notifyOwner });
        const withoutService = new ChatService({ botStore, messageStore, runner: withoutNotices, dataDir });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finishedWith = waitForTurnFinish(withService, bot.id);

        await withService.sendMessage(bot.id, 'Hi');
        await finishedWith;

        const finishedWithout = waitForTurnFinish(withoutService, bot.id);

        await withoutService.sendMessage(bot.id, 'Hi');
        await finishedWithout;

        expect(withNotices.receivedRequests[0]?.allowedTools)
            .toContain(NOTIFICATIONS_ENABLE_TOOL_FULL_NAME);
        expect(withNotices.receivedRequests[0]?.allowedTools)
            .toContain(NOTIFICATIONS_DISABLE_TOOL_FULL_NAME);
        expect(withNotices.receivedRequests[0]?.systemPrompt)
            .toContain('notifications_enable');
        expect(withoutNotices.receivedRequests[0]?.allowedTools)
            .not.toContain(NOTIFICATIONS_ENABLE_TOOL_FULL_NAME);
        expect(withoutNotices.receivedRequests[0]?.allowedTools)
            .not.toContain(NOTIFICATIONS_DISABLE_TOOL_FULL_NAME);
        expect(withoutNotices.receivedRequests[0]?.systemPrompt)
            .not.toContain('notifications_enable');
    });

    describe('the notification card', () => {
        async function postCard(service: ChatService, botId: string): Promise<ChatMessage> {
            await service.postNotificationCard(botId);

            const card = ((await service.listMessages(botId)) ?? []).at(-1);

            if (card === undefined) {
                throw new Error('The card was not posted.');
            }

            return card;
        }

        it('posts a card that says what is sent and offers a button to turn notifications on', async () => {
            const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, notifyOwner });
            const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
            const card = await postCard(service, bot.id);

            expect(card.role)
                .toBe('assistant');
            expect(card.body)
                .toMatchObject({
                    kind: 'choice',
                    isNotificationOptIn: true,
                    options: [{ id: 'enable', label: 'Turn on notifications' }, { id: 'later', label: 'Not now' }],
                });
            expect(JSON.stringify(card.body))
                .toContain('the first line of my reply');
        });

        it('closes the card with the answer of the owner, once', async () => {
            const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, notifyOwner });
            const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
            const card = await postCard(service, bot.id);
            const answered = await service.answerSetup(bot.id, card.id, 'choice', 'enable');

            expect(answered.body)
                .toMatchObject({ kind: 'choice', chosenId: 'enable' });
            await expect(service.answerSetup(bot.id, card.id, 'choice', 'later'))
                .rejects.toThrow('already answered');
        });

        it('refuses an answer that is not a button of the card', async () => {
            const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, notifyOwner });
            const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
            const card = await postCard(service, bot.id);

            await expect(service.answerSetup(bot.id, card.id, 'choice', 'delete-everything'))
                .rejects.toThrow('not an answer of this card');
            const unchanged = ((await service.listMessages(bot.id)) ?? []).at(-1);

            expect(unchanged?.body)
                .not.toHaveProperty('chosenId');
        });

        it('posts a card that turns notifications off for this browser, and closes it once', async () => {
            const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, notifyOwner });
            const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

            await service.postNotificationOffCard(bot.id);

            const card = ((await service.listMessages(bot.id)) ?? []).at(-1);

            expect(card?.body)
                .toMatchObject({
                    kind: 'choice',
                    isNotificationOptOut: true,
                    options: [{ id: 'disable', label: 'Turn off notifications' }, { id: 'keep', label: 'Keep them' }],
                });
            expect(card?.body)
                .not.toHaveProperty('isNotificationOptIn');

            const answered = await service.answerSetup(bot.id, card?.id ?? '', 'choice', 'disable');

            expect(answered.body)
                .toMatchObject({ kind: 'choice', chosenId: 'disable' });
            await expect(service.answerSetup(bot.id, card?.id ?? '', 'choice', 'keep'))
                .rejects.toThrow('already answered');
        });

        it('does not let another bot answer the card', async () => {
            const service = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, notifyOwner });
            const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
            const other = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
            const card = await postCard(service, bot.id);

            await expect(service.answerSetup(other.id, card.id, 'choice', 'enable'))
                .rejects.toThrow();
        });
    });
});
