import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { WebhookRecord, WebhookStore } from '../store/WebhookStore.ts';
import { buildWebhookMessage } from './webhookMessage.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhookMemory.ts';
import { hashWebhookToken } from './webhookToken.ts';
import { BotDeletingError } from '../bots/BotDeletingError.ts';

const BOT_DELETING: WebhookHookErrorResponse = { error: 'This bot is being deleted.' };

interface WebhookHookErrorResponse {
    error: string;
}

interface WebhookHookAcceptedResponse {
    status: 'queued';
}

interface WebhookHookDuplicateResponse {
    status: 'duplicate';
}

interface WebhookHookVariables {
    webhook: WebhookRecord;
}

interface WebhookHookEnvironment {
    Variables: WebhookHookVariables;
}

interface WebhookHookRoutesOptions {
    webhookStore: WebhookStore;
    // A webhook turn waits for the setup to finish, as a chat message does.
    isReady: () => boolean;
    // The message goes through the same queue as a chat message, and uses the routines model choice.
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    // The number of webhook messages waiting in the bot's queue. The calls are refused at MAX_QUEUED_WEBHOOK_TURNS.
    queuedWebhookTurns?: (botId: string) => number;
    // The refused calls of each webhook, which the owner and the bot can list.
    refusals?: WebhookRefusalLog;
    deliveries?: DeliveryMemory;
    now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;
// The limit is shared by all webhooks of one bot, so creating more webhooks does not add calls.
const RATE_LIMIT_PER_BOT = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Webhook messages waiting in one bot's queue. A call past this is refused until the queue shrinks.
const MAX_QUEUED_WEBHOOK_TURNS = 10;
const DELIVERY_HEADER = 'X-Delivery-Id';
const MAX_DELIVERY_ID_LENGTH = 200;

const NOT_FOUND: WebhookHookErrorResponse = { error: 'No webhook has this URL.' };
const TOO_LARGE: WebhookHookErrorResponse = { error: `The body is larger than ${String(MAX_BODY_BYTES)} bytes.` };
const TOO_MANY: WebhookHookErrorResponse = { error: 'This bot got too many webhook calls. Wait a minute and try again.' };
const QUEUE_FULL: WebhookHookErrorResponse = { error: 'This bot has too many webhook messages waiting. Wait for them to finish, then try again.' };
const NOT_READY: WebhookHookErrorResponse = { error: 'CloudBot is starting. Try again in a moment.' };
const BOT_MISSING: WebhookHookErrorResponse = { error: 'The bot of this webhook no longer exists.' };
const DUPLICATE: WebhookHookDuplicateResponse = { status: 'duplicate' };

// Counts the calls of each bot in the last minute. Calls past the limit are refused until old ones age out.
function createRateLimiter(now: () => number): (key: string) => boolean {
    const callTimes = new Map<string, number[]>();

    return (key: string): boolean => {
        const currentTime = now();
        const recentTimes = (callTimes.get(key) ?? []).filter(time => currentTime - time < RATE_LIMIT_WINDOW_MS);

        if (recentTimes.length >= RATE_LIMIT_PER_BOT) {
            callTimes.set(key, recentTimes);

            return false;
        }

        recentTimes.push(currentTime);
        callTimes.set(key, recentTimes);

        return true;
    };
}

// The id is trimmed. An empty id, or one longer than the limit, counts as no id at all.
function readDeliveryId(header: string | undefined): string | undefined {
    const trimmed = (header ?? '').trim();

    return trimmed === '' || trimmed.length > MAX_DELIVERY_ID_LENGTH ? undefined : trimmed;
}

// This route is public. It sits outside the session check, so a caller only needs the token in the URL.
function createWebhookHookRoutes(options: WebhookHookRoutesOptions): Hono<WebhookHookEnvironment> {
    const routes = new Hono<WebhookHookEnvironment>();
    const now = options.now ?? (() => Date.now());
    const refusals = options.refusals ?? new WebhookRefusalLog({ now });
    const deliveries = options.deliveries ?? new DeliveryMemory({ now });
    const queuedWebhookTurns = options.queuedWebhookTurns ?? (() => 0);
    const isWithinRateLimit = createRateLimiter(now);
    // Calls per bot that are past the queue check and not finished yet.
    const inFlightCalls = new Map<string, number>();

    function changeInFlight(botId: string, change: number): void {
        const next = (inFlightCalls.get(botId) ?? 0) + change;

        inFlightCalls.set(botId, next);
    }
    // The webhook is looked up before the body is read, so a body that is too large can be recorded for it.
    const limitBody = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (context) => {
            const webhook = context.get('webhook') as WebhookRecord | undefined;

            if (webhook !== undefined) {
                refusals.record(webhook.id, 'body too large');
            }

            return context.json(TOO_LARGE, 413);
        },
    });

    routes.post('/hooks/:token', async (context, next) => {
        // Only the hash is stored, so the token is hashed and looked up. It is never written anywhere.
        const token = context.req.param('token');
        const tokenHash = hashWebhookToken(token);
        const webhook = await options.webhookStore.findByTokenHash(tokenHash);

        if (webhook === undefined) {
            return context.json(NOT_FOUND, 404);
        }

        context.set('webhook', webhook);
        await next();
    }, limitBody, async (context) => {
        const webhook = context.get('webhook');
        const headerValue = context.req.header(DELIVERY_HEADER);
        const deliveryId = readDeliveryId(headerValue);

        // The id is taken before anything is awaited, so a call with the same id that arrives meanwhile is a duplicate.
        if (deliveryId !== undefined && !deliveries.reserve(webhook.id, deliveryId)) {
            return context.json(DUPLICATE, 200);
        }

        let isQueued = false;

        try {
            if (!options.isReady()) {
                refusals.record(webhook.id, 'not ready');

                return context.json(NOT_READY, 503);
            }

            if (!isWithinRateLimit(webhook.botId)) {
                refusals.record(webhook.id, 'rate limit');

                return context.json(TOO_MANY, 429);
            }

            // The calls still being handled count too, so a burst cannot pass the cap while the queue is still empty.
            const waitingCount = queuedWebhookTurns(webhook.botId) + (inFlightCalls.get(webhook.botId) ?? 0);

            if (waitingCount >= MAX_QUEUED_WEBHOOK_TURNS) {
                refusals.record(webhook.id, 'queue full');

                return context.json(QUEUE_FULL, 429);
            }

            changeInFlight(webhook.botId, 1);

            try {
                const body = await context.req.text();
                const message = buildWebhookMessage(webhook.name, body);
                let sent: unknown;

                try {
                    sent = await options.sendMessage(webhook.botId, message);
                } catch (error: unknown) {
                    if (error instanceof BotDeletingError) {
                        return context.json(BOT_DELETING, 409);
                    }

                    throw error;
                }

                if (sent === undefined) {
                    return context.json(BOT_MISSING, 404);
                }

                // Only a call that was queued is remembered, so a refused call can be sent again with the same id.
                if (deliveryId !== undefined) {
                    deliveries.remember(webhook.id, deliveryId);
                }

                isQueued = true;

                const accepted: WebhookHookAcceptedResponse = { status: 'queued' };

                return context.json(accepted, 202);
            } finally {
                changeInFlight(webhook.botId, -1);
            }
        } finally {
            if (deliveryId !== undefined && !isQueued) {
                deliveries.release(webhook.id, deliveryId);
            }
        }
    });

    return routes;
}

export { MAX_BODY_BYTES, MAX_QUEUED_WEBHOOK_TURNS, RATE_LIMIT_PER_BOT, createWebhookHookRoutes };
export type { WebhookHookRoutesOptions };
