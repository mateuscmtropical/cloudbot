import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatWebhookUrlEvent } from '../../shared/chatTypes.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WebhookStore } from '../store/WebhookStore.ts';

import { MAX_WEBHOOKS_PER_BOT } from './createWebhookRoutes.ts';
import { createWebhookTools } from './createWebhookTools.ts';
import type { WebhookCreation, WebhookToolResult } from './createWebhookTools.ts';

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<WebhookToolResult>;

const BASE_URL = 'https://bot.example.test';

interface FakeCreation extends WebhookCreation {
    announced: ChatWebhookUrlEvent[];
}

// A web app listens for the bot when isListening is true. Announced events are kept here for the test to read.
function createFakeCreation(isListening = true): FakeCreation {
    const announced: ChatWebhookUrlEvent[] = [];

    return {
        publicBaseUrl: BASE_URL,
        isListening: () => isListening,
        announce: (event) => {
            announced.push(event);
        },
        announced,
    };
}

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

    function findHandler(forBotId: string, name: string, creation: WebhookCreation = createFakeCreation()): ToolHandler {
        const tools = createWebhookTools(store, forBotId, creation) as unknown as { name: string; handler: unknown }[];
        const found = tools.find(candidate => candidate.name === name);

        if (found === undefined) {
            throw new Error(`No tool ${name}`);
        }

        return found.handler as ToolHandler;
    }

    it('offers list, create and delete', () => {
        const names = (createWebhookTools(store, botId, createFakeCreation()) as unknown as { name: string }[]).map(candidate => candidate.name);

        expect(names)
            .toEqual(['webhook_list', 'webhook_create', 'webhook_delete']);
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

    it('creates a webhook, sends its URL once as an event, and answers without the URL or token', async () => {
        const creation = createFakeCreation();

        const result = await findHandler(botId, 'webhook_create', creation)({ name: 'form tool' }, {});
        const [event] = creation.announced;
        const token = event?.url.replace(`${BASE_URL}/hooks/`, '') ?? '';

        expect(result.isError)
            .toBeUndefined();
        expect(creation.announced)
            .toHaveLength(1);
        expect(event)
            .toMatchObject({ type: 'webhookUrl', botId, name: 'form tool' });
        expect(event?.url)
            .toContain(`${BASE_URL}/hooks/`);
        expect(result.content[0]?.text)
            .toContain('form tool');
        expect(result.content[0]?.text)
            .not.toContain(BASE_URL);
        expect(result.content[0]?.text)
            .not.toContain(token);
        expect(await store.list(botId))
            .toHaveLength(1);
    });

    it('refuses to create when no web app is listening, and creates nothing', async () => {
        const creation = createFakeCreation(false);

        const result = await findHandler(botId, 'webhook_create', creation)({ name: 'form tool' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain('open the web app');
        expect(creation.announced)
            .toEqual([]);
        expect(await store.list(botId))
            .toEqual([]);
    });

    it('removes the webhook again when the web app closed while it was made', async () => {
        let listenerCalls = 0;
        const creation: FakeCreation = { ...createFakeCreation(), isListening: () => {
            listenerCalls += 1;

            return listenerCalls === 1;
        } };

        const result = await findHandler(botId, 'webhook_create', creation)({ name: 'form tool' }, {});

        expect(result.isError)
            .toBe(true);
        expect(creation.announced)
            .toEqual([]);
        expect(await store.list(botId))
            .toEqual([]);
    });

    it('refuses a name that is empty or has a line break, and creates nothing', async () => {
        const creation = createFakeCreation();

        const empty = await findHandler(botId, 'webhook_create', creation)({ name: '   ' }, {});
        const twoLines = await findHandler(botId, 'webhook_create', creation)({ name: 'form\ntool' }, {});

        expect(empty.isError)
            .toBe(true);
        expect(twoLines.isError)
            .toBe(true);
        expect(creation.announced)
            .toEqual([]);
        expect(await store.list(botId))
            .toEqual([]);
    });

    it('refuses a webhook past the limit of the bot', async () => {
        const creation = createFakeCreation();

        const indexes = Array.from({ length: MAX_WEBHOOKS_PER_BOT }, (_unused, index) => index);

        await Promise.all(indexes.map(index => store.add(botId, `Hook ${String(index)}`, `hash-${String(index)}`)));

        const result = await findHandler(botId, 'webhook_create', creation)({ name: 'one too many' }, {});

        expect(result.isError)
            .toBe(true);
        expect(result.content[0]?.text)
            .toContain(`${String(MAX_WEBHOOKS_PER_BOT)} webhooks`);
        expect(creation.announced)
            .toEqual([]);
        expect(await store.list(botId))
            .toHaveLength(MAX_WEBHOOKS_PER_BOT);
    });
});
