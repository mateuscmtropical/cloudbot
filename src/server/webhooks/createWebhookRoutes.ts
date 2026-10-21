import { Hono } from 'hono';

import type { WebhookRecord, WebhookStore } from '../store/WebhookStore.ts';
import type { BotWebhook, CreatedBotWebhook, WebhookRefusal } from '../../shared/webhookTypes.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhookMemory.ts';
import { buildWebhookUrl, createWebhookToken, hashWebhookToken } from './webhookToken.ts';

interface WebhookErrorResponse {
    error: string;
}

// Webhooks are created, listed and removed here by the owner. The token and its hash are never listed.
interface WebhookRoutesOptions {
    webhookStore: WebhookStore;
    hasBot: (botId: string) => Promise<boolean>;
    // The address the owner reaches the server at. A new webhook URL starts with it.
    publicBaseUrl: string;
    // The refused calls shown with each webhook in the list.
    refusals?: WebhookRefusalLog;
    // The delivery ids of each webhook. They are dropped when the webhook is deleted.
    deliveries?: DeliveryMemory;
}

const MAX_WEBHOOKS_PER_BOT = 10;
const MAX_NAME_LENGTH = 60;

const BOT_NOT_FOUND: WebhookErrorResponse = { error: 'No bot has this id.' };
const WEBHOOK_NOT_FOUND: WebhookErrorResponse = { error: 'This bot has no webhook with this id.' };
const INVALID_NAME: WebhookErrorResponse = { error: `Send a name of 1 to ${String(MAX_NAME_LENGTH)} characters on one line.` };
const TOO_MANY: WebhookErrorResponse = { error: `This bot has ${String(MAX_WEBHOOKS_PER_BOT)} webhooks. Delete one first.` };

function toBotWebhook(record: WebhookRecord, refusals: WebhookRefusal[] = []): BotWebhook {
    return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        refusals,
    };
}

// The name becomes part of the chat message, so it must stay on one line.
function readWebhookName(payload: unknown): string | undefined {
    const name = typeof payload === 'object' && payload !== null && 'name' in payload ? payload.name : undefined;

    if (typeof name !== 'string') {
        return undefined;
    }

    const trimmedName = name.trim();
    const isValid = trimmedName.length >= 1 && trimmedName.length <= MAX_NAME_LENGTH && !/[\r\n]/.test(trimmedName);

    return isValid ? trimmedName : undefined;
}

interface AddBotWebhookProblem {
    problem: WebhookErrorResponse;
}

interface AddBotWebhookSuccess {
    created: CreatedBotWebhook;
}

type AddBotWebhookResult = AddBotWebhookProblem | AddBotWebhookSuccess;

// Shared by the owner route and the bot's webhook_create tool, so both follow the same name and limit rules.
async function addBotWebhook(webhookStore: WebhookStore, botId: string, payload: unknown, publicBaseUrl: string): Promise<AddBotWebhookResult> {
    const name = readWebhookName(payload);

    if (name === undefined) {
        return { problem: INVALID_NAME };
    }

    const existingWebhooks = await webhookStore.list(botId);

    if (existingWebhooks.length >= MAX_WEBHOOKS_PER_BOT) {
        return { problem: TOO_MANY };
    }

    const token = createWebhookToken();
    const tokenHash = hashWebhookToken(token);
    const webhook = await webhookStore.add(botId, name, tokenHash);
    const url = buildWebhookUrl(publicBaseUrl, token);
    const created: CreatedBotWebhook = { ...toBotWebhook(webhook), url };

    return { created };
}

// These routes sit behind the session check.
function createWebhookRoutes(options: WebhookRoutesOptions): Hono {
    const routes = new Hono();
    const refusals = options.refusals ?? new WebhookRefusalLog();
    const deliveries = options.deliveries ?? new DeliveryMemory();

    routes.get('/api/bots/:id/webhooks', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.webhookStore.list(botId);
        const botWebhooks = records.map((record) => {
            const recordRefusals = refusals.list(record.id);

            return toBotWebhook(record, recordRefusals);
        });

        return context.json(botWebhooks);
    });

    routes.post('/api/bots/:id/webhooks', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const result = await addBotWebhook(options.webhookStore, botId, payload, options.publicBaseUrl);

        if ('problem' in result) {
            return context.json(result.problem, 400);
        }

        return context.json(result.created, 201);
    });

    routes.delete('/api/bots/:id/webhooks/:webhookId', async (context) => {
        const botId = context.req.param('id');
        const webhookId = context.req.param('webhookId');
        const isRemoved = await options.webhookStore.remove(botId, webhookId);

        if (!isRemoved) {
            return context.json(WEBHOOK_NOT_FOUND, 404);
        }

        refusals.forget(webhookId);
        deliveries.forget(webhookId);

        return context.body(null, 204);
    });

    return routes;
}

export { MAX_NAME_LENGTH, MAX_WEBHOOKS_PER_BOT, addBotWebhook, createWebhookRoutes, toBotWebhook };
export type { AddBotWebhookResult, BotWebhook, CreatedBotWebhook, WebhookRoutesOptions };
