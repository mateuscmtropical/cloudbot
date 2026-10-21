import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { WebhookStore } from '../store/WebhookStore.ts';
import { buildWebhookMessage } from './webhookMessage.ts';
import { hashWebhookToken } from './webhookToken.ts';

interface WebhookHookErrorResponse {
    error: string;
}

interface WebhookHookAcceptedResponse {
    status: 'queued';
}

interface WebhookHookRoutesOptions {
    webhookStore: WebhookStore;
    // A webhook turn waits for the setup to finish, as a chat message does.
    isReady: () => boolean;
    // The message goes through the same queue as a chat message, and uses the routines model choice.
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    now?: () => number;
}

const MAX_BODY_BYTES = 64 * 1024;
// The limit is shared by all webhooks of one bot, so creating more webhooks does not add calls.
const RATE_LIMIT_PER_BOT = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const NOT_FOUND: WebhookHookErrorResponse = { error: 'No webhook has this URL.' };
const TOO_LARGE: WebhookHookErrorResponse = { error: `The body is larger than ${String(MAX_BODY_BYTES)} bytes.` };
const TOO_MANY: WebhookHookErrorResponse = { error: 'This bot got too many webhook calls. Wait a minute and try again.' };
const NOT_READY: WebhookHookErrorResponse = { error: 'CloudBot is starting. Try again in a moment.' };
const BOT_MISSING: WebhookHookErrorResponse = { error: 'The bot of this webhook no longer exists.' };

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

// This route is public. It sits outside the session check, so a caller only needs the token in the URL.
function createWebhookHookRoutes(options: WebhookHookRoutesOptions): Hono {
    const routes = new Hono();
    const isWithinRateLimit = createRateLimiter(options.now ?? (() => Date.now()));
    const limitBody = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: context => context.json(TOO_LARGE, 413),
    });

    routes.post('/hooks/:token', limitBody, async (context) => {
        // Only the hash is stored, so the token is hashed and looked up. It is never written anywhere.
        const token = context.req.param('token');
        const tokenHash = hashWebhookToken(token);
        const webhook = await options.webhookStore.findByTokenHash(tokenHash);

        if (webhook === undefined) {
            return context.json(NOT_FOUND, 404);
        }

        if (!options.isReady()) {
            return context.json(NOT_READY, 503);
        }

        if (!isWithinRateLimit(webhook.botId)) {
            return context.json(TOO_MANY, 429);
        }

        const body = await context.req.text();
        const message = buildWebhookMessage(webhook.name, body);
        const sent = await options.sendMessage(webhook.botId, message);

        if (sent === undefined) {
            return context.json(BOT_MISSING, 404);
        }

        const accepted: WebhookHookAcceptedResponse = { status: 'queued' };

        return context.json(accepted, 202);
    });

    return routes;
}

export { MAX_BODY_BYTES, RATE_LIMIT_PER_BOT, createWebhookHookRoutes };
export type { WebhookHookRoutesOptions };
