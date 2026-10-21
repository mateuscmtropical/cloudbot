import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotWebhook } from '../../shared/webhookTypes.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WebhookStore } from '../store/WebhookStore.ts';
import { MAX_BODY_BYTES, MAX_QUEUED_WEBHOOK_TURNS, createWebhookHookRoutes } from './createWebhookHookRoutes.ts';
import type { WebhookHookRoutesOptions } from './createWebhookHookRoutes.ts';
import { createWebhookRoutes } from './createWebhookRoutes.ts';
import { DELIVERY_WINDOW_MS, DeliveryMemory, MAX_REFUSALS_PER_WEBHOOK, WebhookRefusalLog } from './webhookMemory.ts';
import { hashWebhookToken } from './webhookToken.ts';

const TOKEN = 'delivery-test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const START_TIME = Date.UTC(2026, 9, 21, 12, 0);
const ONE_MINUTE = 60 * 1000;

describe('webhook delivery ids, queue cap and refusal history', () => {
    let opened: OpenedDatabase;
    let store: WebhookStore;
    let botId: string;
    let currentTime: number;
    let sentTexts: string[];
    let isReady: boolean;
    let queuedCount: number;
    let refusals: WebhookRefusalLog;
    let deliveries: DeliveryMemory;
    let hook: ReturnType<typeof createWebhookHookRoutes>;
    let owner: Hono;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new WebhookStore(opened.db);
        botId = (await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' })).id;
        await store.add(botId, 'Deploy', hashWebhookToken(TOKEN));
        currentTime = START_TIME;
        sentTexts = [];
        isReady = true;
        queuedCount = 0;
        refusals = new WebhookRefusalLog({ now: () => currentTime });
        deliveries = new DeliveryMemory({ now: () => currentTime });
        hook = createHookWith({});
        owner = createWebhookRoutes({
            webhookStore: store,
            hasBot: () => Promise.resolve(true),
            publicBaseUrl: 'https://cloudbot.example.com',
            refusals,
            deliveries,
        });
    });

    // A hook route with the shared memories. The options replace the defaults for one test.
    function createHookWith(options: Partial<WebhookHookRoutesOptions>): ReturnType<typeof createWebhookHookRoutes> {
        return createWebhookHookRoutes({
            webhookStore: store,
            isReady: () => isReady,
            sendMessage: (_botId, text) => {
                sentTexts.push(text);

                return Promise.resolve({});
            },
            queuedWebhookTurns: () => queuedCount,
            refusals,
            deliveries,
            now: () => currentTime,
            ...options,
        });
    }

    // A message that takes a moment to queue, so parallel calls overlap.
    function slowSend(_botId: string, text: string): Promise<unknown> {
        return new Promise((resolve) => {
            setTimeout(() => {
                sentTexts.push(text);
                resolve({});
            }, 50);
        });
    }

    function postTo(route: ReturnType<typeof createWebhookHookRoutes>, body: string, deliveryId?: string): Promise<Response> {
        const headers: Record<string, string> = deliveryId === undefined ? {} : { 'X-Delivery-Id': deliveryId };

        return Promise.resolve(route.request(`/hooks/${TOKEN}`, { method: 'POST', body, headers }));
    }

    afterEach(() => {
        opened.close();
    });

    async function post(body = 'build passed', deliveryId?: string): Promise<Response> {
        const headers: Record<string, string> = deliveryId === undefined ? {} : { 'X-Delivery-Id': deliveryId };

        return hook.request(`/hooks/${TOKEN}`, { method: 'POST', body, headers });
    }

    async function listWebhooks(): Promise<BotWebhook[]> {
        const response = await owner.request(`/api/bots/${botId}/webhooks`);

        return response.json() as Promise<BotWebhook[]>;
    }

    it('answers a repeat of the same delivery id within 24 hours as a duplicate, and queues it once', async () => {
        const first = await post('one', 'evt-1');

        expect(first.status)
            .toBe(202);

        currentTime += ONE_MINUTE;

        const second = await post('two', 'evt-1');

        expect(second.status)
            .toBe(200);
        expect(await second.json())
            .toEqual({ status: 'duplicate' });
        expect(sentTexts)
            .toHaveLength(1);
    });

    it('queues a delivery id again once 24 hours have passed', async () => {
        await post('one', 'evt-1');

        currentTime += DELIVERY_WINDOW_MS + 1;

        const later = await post('two', 'evt-1');

        expect(later.status)
            .toBe(202);
        expect(sentTexts)
            .toHaveLength(2);
    });

    it('lets a refused call be retried with the same delivery id, and remembers it once queued', async () => {
        isReady = false;

        const refused = await post('one', 'evt-2');

        expect(refused.status)
            .toBe(503);

        isReady = true;

        const retried = await post('one', 'evt-2');

        expect(retried.status)
            .toBe(202);

        const repeat = await post('one', 'evt-2');

        expect(repeat.status)
            .toBe(200);
        expect(sentTexts)
            .toHaveLength(1);
    });

    it('treats a delivery id longer than 200 characters as no id at all', async () => {
        const longId = 'a'.repeat(201);

        await post('one', longId);

        const second = await post('two', longId);

        expect(second.status)
            .toBe(202);
        expect(sentTexts)
            .toHaveLength(2);
    });

    it('answers 429 with the queue-full text when the bot already has the maximum waiting webhook messages', async () => {
        queuedCount = MAX_QUEUED_WEBHOOK_TURNS;

        const response = await post('one');
        const body = await response.json() as { error: string };

        expect(response.status)
            .toBe(429);
        expect(body.error)
            .toContain('too many webhook messages waiting');
        expect(body.error)
            .not.toContain('too many webhook calls');
        expect(sentTexts)
            .toEqual([]);

        queuedCount = MAX_QUEUED_WEBHOOK_TURNS - 1;

        const allowed = await post('one');

        expect(allowed.status)
            .toBe(202);
    });

    it('queues one of five parallel calls with the same delivery id, and answers the rest as duplicates', async () => {
        const slowHook = createHookWith({ sendMessage: slowSend });
        const responses = await Promise.all(Array.from({ length: 5 }, () => postTo(slowHook, 'build', 'burst-1')));
        const statuses = responses.map(response => response.status);

        expect(statuses.filter(status => status === 202))
            .toHaveLength(1);
        expect(statuses.filter(status => status === 200))
            .toHaveLength(4);
        expect(sentTexts)
            .toHaveLength(1);
    });

    it('releases a delivery id whose call was not queued, so the same id can be sent again', async () => {
        const missingBot = createHookWith({ sendMessage: () => Promise.resolve(undefined) });
        const refused = await postTo(missingBot, 'one', 'evt-release');

        expect(refused.status)
            .toBe(404);

        const retried = await postTo(hook, 'one', 'evt-release');

        expect(retried.status)
            .toBe(202);
    });

    it('lets only one of twenty parallel calls past a queue that has room for one more', async () => {
        const burstHook = createHookWith({ sendMessage: slowSend, queuedWebhookTurns: () => MAX_QUEUED_WEBHOOK_TURNS - 1 });
        const responses = await Promise.all(Array.from({ length: 20 }, () => postTo(burstHook, 'ping')));
        const statuses = responses.map(response => response.status);

        expect(statuses.filter(status => status === 202))
            .toHaveLength(1);
        expect(statuses.filter(status => status === 429))
            .toHaveLength(19);
        expect(sentTexts)
            .toHaveLength(1);
    });

    it('drops the refused calls and delivery ids of a webhook when it is deleted', async () => {
        await postTo(hook, 'one', 'evt-delete');

        const [listed] = await listWebhooks();
        const webhookId = listed?.id ?? '';

        refusals.record(webhookId, 'not ready');

        expect(deliveries.isRemembered(webhookId, 'evt-delete'))
            .toBe(true);

        const deleted = await owner.request(`/api/bots/${botId}/webhooks/${webhookId}`, { method: 'DELETE' });

        expect(deleted.status)
            .toBe(204);
        expect(refusals.list(webhookId))
            .toEqual([]);
        expect(deliveries.isRemembered(webhookId, 'evt-delete'))
            .toBe(false);
    });

    it('keeps only the last 20 refused calls per webhook, newest first', async () => {
        isReady = false;

        const calls = Array.from({ length: MAX_REFUSALS_PER_WEBHOOK + 5 }, () => post());

        await Promise.all(calls);

        const [listed] = await listWebhooks();

        expect(listed?.refusals)
            .toHaveLength(MAX_REFUSALS_PER_WEBHOOK);
        expect(listed?.refusals.every(refusal => refusal.reason === 'not ready'))
            .toBe(true);
    });

    it('shows the refused calls to the owner with only the time and the reason', async () => {
        isReady = false;

        await post('SECRET BODY TEXT', 'SECRET-DELIVERY-ID');

        const listedText = JSON.stringify(await listWebhooks());
        const [listed] = await listWebhooks();

        expect(listed?.refusals)
            .toEqual([{ time: START_TIME, reason: 'not ready' }]);
        expect(listedText)
            .not.toContain('SECRET BODY TEXT');
        expect(listedText)
            .not.toContain('SECRET-DELIVERY-ID');
        expect(listedText)
            .not.toContain(TOKEN);
    });

    it('records a 413 for a body that is too large, as body too large', async () => {
        const response = await post('x'.repeat(MAX_BODY_BYTES + 1));

        expect(response.status)
            .toBe(413);

        const [listed] = await listWebhooks();

        expect(listed?.refusals.map(refusal => refusal.reason))
            .toEqual(['body too large']);
    });

    it('records a call refused by the queue cap as queue full', async () => {
        queuedCount = MAX_QUEUED_WEBHOOK_TURNS;

        await post('one');

        const [listed] = await listWebhooks();

        expect(listed?.refusals.map(refusal => refusal.reason))
            .toEqual(['queue full']);
    });
});

describe('WebhookRefusalLog and DeliveryMemory', () => {
    it('forgets a delivery id just after the 24 hour window and keeps it just before', () => {
        let currentTime = 1_000_000;
        const deliveries = new DeliveryMemory({ now: () => currentTime });

        deliveries.remember('hook-1', 'evt-a');
        currentTime += DELIVERY_WINDOW_MS - 1;

        expect(deliveries.isRemembered('hook-1', 'evt-a'))
            .toBe(true);

        currentTime += 1;

        expect(deliveries.isRemembered('hook-1', 'evt-a'))
            .toBe(false);
    });

    it('keeps at most 1000 delivery ids per webhook, dropping the oldest', () => {
        const deliveries = new DeliveryMemory({ now: () => START_TIME });

        Array.from({ length: 1001 }, (_unused, index) => index)
            .forEach((index) => {
                deliveries.remember('hook-1', `evt-${String(index)}`);
            });

        expect(deliveries.isRemembered('hook-1', 'evt-0'))
            .toBe(false);
        expect(deliveries.isRemembered('hook-1', 'evt-1'))
            .toBe(true);
        expect(deliveries.isRemembered('hook-1', 'evt-1000'))
            .toBe(true);
    });

    it('takes a delivery id once until it is released or remembered', () => {
        const deliveries = new DeliveryMemory({ now: () => START_TIME });

        expect(deliveries.reserve('hook-1', 'evt-a'))
            .toBe(true);
        expect(deliveries.reserve('hook-1', 'evt-a'))
            .toBe(false);

        deliveries.release('hook-1', 'evt-a');

        expect(deliveries.reserve('hook-1', 'evt-a'))
            .toBe(true);

        deliveries.remember('hook-1', 'evt-a');

        expect(deliveries.reserve('hook-1', 'evt-a'))
            .toBe(false);
    });

    it('forgets the refused calls of one webhook only', () => {
        const refusalLog = new WebhookRefusalLog({ now: () => START_TIME });

        refusalLog.record('hook-1', 'rate limit');
        refusalLog.record('hook-2', 'not ready');
        refusalLog.forget('hook-1');

        expect(refusalLog.list('hook-1'))
            .toEqual([]);
        expect(refusalLog.list('hook-2')
            .map(refusal => refusal.reason))
            .toEqual(['not ready']);
    });

    it('keeps the history of each webhook apart', () => {
        const refusalLog = new WebhookRefusalLog({ now: () => START_TIME });

        refusalLog.record('hook-1', 'rate limit');
        refusalLog.record('hook-2', 'not ready');

        const firstList = refusalLog.list('hook-1');
        const secondList = refusalLog.list('hook-2');
        const firstReasons = firstList.map(refusal => refusal.reason);
        const secondReasons = secondList.map(refusal => refusal.reason);

        expect(firstReasons)
            .toEqual(['rate limit']);
        expect(secondReasons)
            .toEqual(['not ready']);
    });
});
