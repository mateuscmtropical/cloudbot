import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WebhookStore } from '../store/WebhookStore.ts';

import { createWebhookTools } from './createWebhookTools.ts';
import type { WebhookToolResult } from './createWebhookTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<WebhookToolResult>;

describe('createWebhookTools', () => {
    let opened: OpenedDatabase;
    let store: WebhookStore;
    let botId: string;
    let otherBotId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new WebhookStore(opened.db);

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });

        botId = bot.id;
        otherBotId = otherBot.id;
    });

    afterEach(() => {
        opened.close();
    });

    function findHandler(forBotId: string, name: string): ToolHandler {
        const tools = createWebhookTools(store, forBotId) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        if (found === undefined) {
            throw new Error(`No tool ${name}`);
        }

        return found.handler as ToolHandler;
    }

    it('has no create tool, since the owner creates webhooks in the panel', () => {
        const names = (createWebhookTools(store, botId) as unknown as { name: string }[]).map(candidate => candidate.name);

        expect(names)
            .toEqual(['webhook_list', 'webhook_delete']);
    });

    it('lists webhooks by id and name, without any URL', async () => {
        await store.add(botId, 'Deploy', 'hash-one');

        const listed = await findHandler(botId, 'webhook_list')({}, {});
        const webhookId = (await store.list(botId))[0]?.id ?? '';

        expect(listed.content[0]?.text)
            .toBe(`- ${webhookId}: "Deploy"`);
        expect(listed.content[0]?.text)
            .not.toContain('hooks/');
    });

    it('says when there are no webhooks', async () => {
        const listed = await findHandler(botId, 'webhook_list')({}, {});

        expect(listed.content[0]?.text)
            .toBe('You have no webhooks.');
    });

    it('deletes a webhook only for its own bot', async () => {
        await store.add(botId, 'Deploy', 'hash-one');
        const webhookId = (await store.list(botId))[0]?.id ?? '';
        const otherDelete = await findHandler(otherBotId, 'webhook_delete')({ id: webhookId }, {});
        const deleted = await findHandler(botId, 'webhook_delete')({ id: webhookId }, {});

        expect(otherDelete.isError)
            .toBe(true);
        expect(deleted.isError)
            .toBeUndefined();
        await expect(store.list(botId))
            .resolves.toEqual([]);
    });
});
