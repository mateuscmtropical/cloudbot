import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { MAX_PUSH_SUBSCRIPTIONS, PushSubscriptionStore } from './PushSubscriptionStore.ts';

describe('PushSubscriptionStore', () => {
    let opened: OpenedDatabase;
    let store: PushSubscriptionStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new PushSubscriptionStore(opened.db, { now: () => Date.UTC(2026, 9, 21, 11, 0) });
    });

    afterEach(() => {
        opened.close();
    });

    it('saves a subscription and lists it', async () => {
        const saved = await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', p256dh: 'key-one', auth: 'auth-one' });

        expect(saved?.createdAt)
            .toBe(Date.UTC(2026, 9, 21, 11, 0));
        await expect(store.list())
            .resolves.toEqual([saved]);
    });

    it('replaces the keys when the same endpoint subscribes again', async () => {
        await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', p256dh: 'key-one', auth: 'auth-one' });
        await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', p256dh: 'key-two', auth: 'auth-two' });

        const records = await store.list();

        expect(records)
            .toHaveLength(1);
        expect(records[0]?.p256dh)
            .toBe('key-two');
        expect(records[0]?.auth)
            .toBe('auth-two');
    });

    it('removes a subscription by its endpoint', async () => {
        await store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/one', p256dh: 'key-one', auth: 'auth-one' });

        await expect(store.remove('https://fcm.googleapis.com/fcm/send/one'))
            .resolves.toBe(true);
        await expect(store.remove('https://fcm.googleapis.com/fcm/send/one'))
            .resolves.toBe(false);
        await expect(store.list())
            .resolves.toEqual([]);
    });

    it('refuses a new endpoint when the table is full but still updates a known one', async () => {
        const numbers = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS }, (_unused, index) => index);

        await Promise.all(numbers.map(number => store.save({ endpoint: `https://fcm.googleapis.com/fcm/send/${String(number)}`, p256dh: 'key', auth: 'auth' })));

        await expect(store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', p256dh: 'key', auth: 'auth' }))
            .resolves.toBeUndefined();
        await expect(store.save({ endpoint: 'https://fcm.googleapis.com/fcm/send/0', p256dh: 'other', auth: 'auth' }))
            .resolves.toBeDefined();
    });
});
