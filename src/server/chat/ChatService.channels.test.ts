import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import { BOT_SEND_TOOL_FULL_NAME } from '../bots/createBotSendTool.ts';
import { CHANNEL_CREATE_TOOL_FULL_NAME, CHANNEL_TOOL_FULL_NAMES } from '../channels/createChannelTools.ts';
import { BotStore } from '../store/BotStore.ts';
import { ChannelStore } from '../store/ChannelStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import { RuleStore } from '../store/RuleStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

describe('ChatService deleting a bot that manages a channel', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let channelStore: ChannelStore;
    let service: ChatService;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-channels-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        channelStore = new ChannelStore(opened.db);
        service = new ChatService({
            botStore,
            messageStore: new MessageStore(opened.db),
            runner: new FakeAgentRunner([]),
            dataDir,
            channelStore,
        });
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    it('refuses to delete the manager, and says which channel it manages', async () => {
        const manager = await botStore.create({ name: 'Ana', title: 'Manager', description: '' });

        await botStore.create({ name: 'Ben', title: 'Helper', description: '' });
        await channelStore.create({ name: 'Project', managerId: manager.id, memberIds: [manager.id] });

        const check = await service.describeBotDelete(manager.id);
        const outcome = await service.deleteBot(manager.id);
        const stillThere = await botStore.getById(manager.id);

        expect(check)
            .toEqual({ ok: false, reason: 'This bot manages a channel. Make another member the manager of that channel first, then delete this bot.' });
        expect(outcome)
            .toBe('manager');
        expect(stillThere)
            .toBeDefined();
    });

    it('still deletes a member that manages no channel, and keeps the channel history', async () => {
        const manager = await botStore.create({ name: 'Ana', title: 'Manager', description: '' });
        const member = await botStore.create({ name: 'Ben', title: 'Helper', description: '' });
        const channel = await channelStore.create({ name: 'Project', managerId: manager.id, memberIds: [manager.id, member.id] });

        await channelStore.appendMessage(channel.id, {
            authorBotId: member.id,
            authorName: 'Ben',
            authorColor: 'blue',
            authorShape: 'puff',
            role: 'assistant',
            kind: 'text',
            body: { kind: 'text', text: 'Done.' },
        });

        const outcome = await service.deleteBot(member.id);
        const history = await channelStore.listRecentMessages(channel.id, 10);
        const authors = history.map(message => message.authorName);

        expect(outcome)
            .toBe('deleted');
        expect(authors)
            .toEqual(['Ben']);
    });

    it('offers the channel tools to the bot only when the approval gate exists', async () => {
        const toolCallReviewer = vi.fn(() => Promise.resolve({ decision: 'ask' as const, summary: 'Change a channel.' }));
        const withGate = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const withGateService = new ChatService({ botStore, messageStore: new MessageStore(opened.db), runner: withGate, dataDir, channelStore, toolCallReviewer, ruleStore: new RuleStore(opened.db) });
        const withoutGate = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const withoutGateService = new ChatService({ botStore, messageStore: new MessageStore(opened.db), runner: withoutGate, dataDir, channelStore, ruleStore: new RuleStore(opened.db) });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finishedWith = waitForTurnFinish(withGateService, bot.id);

        await withGateService.sendMessage(bot.id, 'Hi');
        await finishedWith;

        const finishedWithout = waitForTurnFinish(withoutGateService, bot.id);

        await withoutGateService.sendMessage(bot.id, 'Hi');
        await finishedWithout;

        const channelToolNames: unknown = expect.arrayContaining(CHANNEL_TOOL_FULL_NAMES);
        const withoutChannelTools: unknown = expect.not.arrayContaining([CHANNEL_CREATE_TOOL_FULL_NAME]);

        expect(withGate.receivedRequests[0]?.allowedTools)
            .toEqual(channelToolNames);
        expect(withoutGate.receivedRequests[0]?.allowedTools)
            .toEqual(withoutChannelTools);
    });

    it('serves the channel tools and bot_send to the CLI as the turn tools, behind the same cloudbot prefix', async () => {
        const toolCallReviewer = vi.fn(() => Promise.resolve({ decision: 'ask' as const, summary: 'Change a channel.' }));
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Hello' } }]);
        const service = new ChatService({ botStore, messageStore: new MessageStore(opened.db), runner, dataDir, channelStore, toolCallReviewer, ruleStore: new RuleStore(opened.db) });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const finished = waitForTurnFinish(service, bot.id);

        await service.sendMessage(bot.id, 'Hi');
        await finished;

        const served = (runner.receivedRequests[0]?.tools ?? []).map(tool => `mcp__cloudbot__${tool.name}`);

        expect(served)
            .toEqual(expect.arrayContaining([...CHANNEL_TOOL_FULL_NAMES, BOT_SEND_TOOL_FULL_NAME]));
    });
});

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
