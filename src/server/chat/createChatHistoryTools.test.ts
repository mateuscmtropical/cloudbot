import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { createChatHistoryTools } from './createChatHistoryTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<ProfileToolResult>;

describe('chat history tools', () => {
    let opened: OpenedDatabase;
    let messageStore: MessageStore;
    let botId: string;
    let otherBotId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        const botStore = new BotStore(opened.db);

        botId = (await botStore.create({ name: 'Ana', title: '', description: '' })).id;
        otherBotId = (await botStore.create({ name: 'Bia', title: '', description: '' })).id;
        messageStore = new MessageStore(opened.db, { now: () => Date.UTC(2026, 0, 5, 10, 30) });
    });

    afterEach(() => {
        opened.close();
    });

    function handlerOf(name: string): ToolHandler {
        const tools = createChatHistoryTools(messageStore, botId) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        return found?.handler as ToolHandler;
    }

    function textOf(result: ProfileToolResult): string {
        return result.content.map(part => ('text' in part ? part.text : ''))
            .join('');
    }

    it('finds a message of its own chat with id, date and role, and never one of another bot', async () => {
        const mine = await messageStore.add({ botId, role: 'user', kind: 'text', content: { kind: 'text', text: 'the budget is 500' } });

        await messageStore.add({ botId: otherBotId, role: 'user', kind: 'text', content: { kind: 'text', text: 'the budget is 900' } });

        const result = await handlerOf('chat_search')({ query: 'budget' }, {});
        const text = textOf(result);

        expect(text)
            .toContain(`id ${mine.id}, 2026-01-05 10:30, user: the *budget* is 500`);
        expect(text)
            .not.toContain('900');
        expect(textOf(await handlerOf('chat_search')({ query: 'nothing' }, {})))
            .toBe('No message matches.');
    });

    it('reads the messages around a hit, cut to a size, and refuses an id of another bot', async () => {
        await messageStore.add({ botId, role: 'user', kind: 'text', content: { kind: 'text', text: 'before' } });
        const hit = await messageStore.add({ botId, role: 'assistant', kind: 'text', content: { kind: 'text', text: 'x'.repeat(2000) } });
        const foreign = await messageStore.add({ botId: otherBotId, role: 'user', kind: 'text', content: { kind: 'text', text: 'hidden' } });

        const result = await handlerOf('chat_context')({ messageId: hit.id, before: 1, after: 1 }, {});
        const text = textOf(result);

        expect(text)
            .toContain('user: before');
        expect(text)
            .toContain('(the hit)');
        expect(text.length)
            .toBeLessThan(800);

        const refused = await handlerOf('chat_context')({ messageId: foreign.id }, {});

        expect(refused.isError)
            .toBe(true);
    });
});
