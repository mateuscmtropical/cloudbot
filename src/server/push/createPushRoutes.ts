import { Hono } from 'hono';

import type { PushKeyResponse, PushSubscriptionInput, PushUnsubscribeInput } from '../../shared/pushTypes.ts';
import type { PushSubscriptionStore } from '../store/PushSubscriptionStore.ts';
import { parsePushEndpoint } from './pushEndpoint.ts';
import { encryptPushPayload } from './webPushCrypto.ts';

interface PushErrorResponse {
    error: string;
}

interface PushRoutesOptions {
    store: PushSubscriptionStore;
    publicKey: string;
}

const INVALID_BODY: PushErrorResponse = { error: 'Send the subscription of the browser, with an endpoint and keys.' };
const UNKNOWN_SERVICE: PushErrorResponse = { error: 'This browser uses a push service that CloudBot does not send to.' };
const INVALID_KEYS: PushErrorResponse = { error: 'The keys of this subscription are not valid.' };
const INVALID_UNSUBSCRIBE: PushErrorResponse = { error: 'Send the endpoint of the subscription to remove.' };
const TOO_MANY: PushErrorResponse = { error: 'Too many browsers have notifications on. Turn them off in one of them first.' };

// A browser gives a 65 byte key and a 16 byte secret as base64url without padding. Nothing else is stored.
const P256DH_PATTERN = /^[A-Za-z0-9_-]{87}$/;
const AUTH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const MAX_ENDPOINT_LENGTH = 2048;

function readText(source: unknown, name: string): string | undefined {
    if (typeof source !== 'object' || source === null) {
        return undefined;
    }

    const candidate: unknown = Reflect.get(source, name);

    return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
}

function readSubscription(requestBody: unknown): PushSubscriptionInput | undefined {
    const endpoint = readText(requestBody, 'endpoint');
    const keys: unknown = typeof requestBody === 'object' && requestBody !== null ? Reflect.get(requestBody, 'keys') : undefined;
    const p256dh = readText(keys, 'p256dh');
    const auth = readText(keys, 'auth');

    return endpoint === undefined || p256dh === undefined || auth === undefined ? undefined : { endpoint, keys: { p256dh, auth } };
}

function readUnsubscribe(requestBody: unknown): PushUnsubscribeInput | undefined {
    const endpoint = readText(requestBody, 'endpoint');

    return endpoint === undefined || endpoint.length > MAX_ENDPOINT_LENGTH ? undefined : { endpoint };
}

async function readJson(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        return undefined;
    }
}

// A dry run of the encryption. It fails for keys of the wrong size and for a point that is not on the curve.
function hasUsableKeys(subscription: PushSubscriptionInput): boolean {
    if (!P256DH_PATTERN.test(subscription.keys.p256dh) || !AUTH_PATTERN.test(subscription.keys.auth)) {
        return false;
    }

    try {
        const emptyPayload = Buffer.alloc(0);

        encryptPushPayload(emptyPayload, subscription.keys);

        return true;
    } catch {
        return false;
    }
}

// These routes sit behind the session check. The browser asks for the public key, subscribes, and sends the result here.
function createPushRoutes(options: PushRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/push/key', (context) => {
        const body: PushKeyResponse = { publicKey: options.publicKey };

        return context.json(body);
    });

    routes.post('/api/push/subscriptions', async (context) => {
        const requestBody = await readJson(context.req.raw);
        const subscription = readSubscription(requestBody);

        if (subscription === undefined) {
            return context.json(INVALID_BODY, 400);
        }

        // The endpoint is an address from the browser, and the server sends to it. Only known push services pass.
        if (parsePushEndpoint(subscription.endpoint) === undefined) {
            return context.json(UNKNOWN_SERVICE, 400);
        }

        if (!hasUsableKeys(subscription)) {
            return context.json(INVALID_KEYS, 400);
        }

        const saved = await options.store.save({ endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth });

        if (saved === undefined) {
            return context.json(TOO_MANY, 409);
        }

        return context.body(null, 204);
    });

    // The browser that turns notifications off sends its own endpoint. Removing one that is not stored is fine.
    routes.delete('/api/push/subscriptions', async (context) => {
        const requestBody = await readJson(context.req.raw);
        const unsubscribe = readUnsubscribe(requestBody);

        if (unsubscribe === undefined) {
            return context.json(INVALID_UNSUBSCRIBE, 400);
        }

        await options.store.remove(unsubscribe.endpoint);

        return context.body(null, 204);
    });

    return routes;
}

export { createPushRoutes };
export type { PushRoutesOptions };
