import { createECDH } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { MAX_PUSH_SUBSCRIPTIONS, PushSubscriptionStore } from '../store/PushSubscriptionStore.ts';
import { createPushRoutes } from './createPushRoutes.ts';

function validKeys(): { p256dh: string; auth: string } {
    const ecdh = createECDH('prime256v1');

    ecdh.generateKeys();

    return { p256dh: ecdh.getPublicKey()
        .toString('base64url'), auth: Buffer.alloc(16, 5)
        .toString('base64url') };
}

// Each case changes a good pair of keys so that only its shape is wrong.
function breakKeys(keys: { p256dh: string; auth: string }, change: string): { p256dh: string; auth: string } {
    const changes: Record<string, { p256dh: string; auth: string }> = {
        'padded-key': { p256dh: keys.p256dh + '=', auth: keys.auth },
        'padded-secret': { p256dh: keys.p256dh, auth: keys.auth + '==' },
        'spaced-key': { p256dh: keys.p256dh.slice(0, 40) + ' ' + keys.p256dh.slice(41), auth: keys.auth },
        'plus-secret': { p256dh: keys.p256dh, auth: keys.auth.slice(0, 21) + '+' },
        'long-secret': { p256dh: keys.p256dh, auth: keys.auth + 'A' },
    };

    return changes[change] ?? keys;
}

describe('push routes', () => {
    let opened: OpenedDatabase;
    let store: PushSubscriptionStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new PushSubscriptionStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    function createRoutes(): ReturnType<typeof createPushRoutes> {
        return createPushRoutes({ store, publicKey: 'public-key-text' });
    }

    async function subscribe(body: unknown): Promise<Response> {
        const response = await createRoutes()
            .request('/api/push/subscriptions', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

        return response;
    }

    it('gives the public key and nothing else', async () => {
        const response = await createRoutes()
            .request('/api/push/key');

        expect(response.status)
            .toBe(200);
        await expect(response.json())
            .resolves.toEqual({ publicKey: 'public-key-text' });
    });

    it('saves the subscription of a browser', async () => {
        const response = await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: validKeys() });

        expect(response.status)
            .toBe(204);

        const saved = await store.list();

        expect(saved.map(record => record.endpoint))
            .toEqual(['https://fcm.googleapis.com/fcm/send/abc']);
    });

    it('refuses an endpoint that is not a known push service, and saves nothing', async () => {
        const response = await subscribe({ endpoint: 'http://169.254.169.254/latest', keys: validKeys() });

        expect(response.status)
            .toBe(400);
        await expect(store.list())
            .resolves.toEqual([]);
    });

    it.each([
        ['no body', undefined],
        ['no keys', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }],
        ['a number for the endpoint', { endpoint: 5, keys: validKeys() }],
        ['an empty auth', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: validKeys().p256dh, auth: '' } }],
    ])('answers 400 for %s', async (_label, body) => {
        const response = await subscribe(body);

        expect(response.status)
            .toBe(400);
    });

    it('refuses keys of the wrong size', async () => {
        const response = await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'AAAA', auth: 'AAAA' } });

        expect(response.status)
            .toBe(400);
        await expect(store.list())
            .resolves.toEqual([]);
    });

    it('answers 409 when too many browsers are subscribed', async () => {
        const numbers = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS }, (_unused, index) => index);

        await Promise.all(numbers.map(number => store.save({ endpoint: `https://fcm.googleapis.com/fcm/send/${String(number)}`, p256dh: 'key', auth: 'auth' })));

        const response = await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: validKeys() });

        expect(response.status)
            .toBe(409);
    });

    it.each([
        ['a key with base64 padding', 'padded-key'],
        ['a secret with base64 padding', 'padded-secret'],
        ['a key with a space in it', 'spaced-key'],
        ['a secret of standard base64 with a plus sign', 'plus-secret'],
        ['a secret that is too long', 'long-secret'],
    ])('refuses %s before it tries the keys', async (_label, change) => {
        const response = await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: breakKeys(validKeys(), change) });

        expect(response.status)
            .toBe(400);
        await expect(store.list())
            .resolves.toEqual([]);
    });

    describe('removing a subscription', () => {
        async function unsubscribe(body: unknown): Promise<Response> {
            const response = await createRoutes()
                .request('/api/push/subscriptions', { method: 'DELETE', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

            return response;
        }

        it('removes the subscription of the endpoint and keeps the others', async () => {
            await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine', keys: validKeys() });
            await subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/other', keys: validKeys() });

            const response = await unsubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine' });

            expect(response.status)
                .toBe(204);

            const saved = await store.list();

            expect(saved.map(record => record.endpoint))
                .toEqual(['https://fcm.googleapis.com/fcm/send/other']);
        });

        it('answers 204 for an endpoint that is not stored', async () => {
            const response = await unsubscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/unknown' });

            expect(response.status)
                .toBe(204);
        });

        it.each([
            ['no body', undefined],
            ['an empty endpoint', { endpoint: '' }],
            ['a number for the endpoint', { endpoint: 5 }],
            ['an endpoint that is too long', { endpoint: `https://fcm.googleapis.com/${'a'.repeat(2100)}` }],
        ])('answers 400 for %s', async (_label, body) => {
            const response = await unsubscribe(body);

            expect(response.status)
                .toBe(400);
        });
    });
});
