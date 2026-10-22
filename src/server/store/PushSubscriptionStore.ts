import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { pushSubscriptions } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type PushSubscriptionRecord = typeof pushSubscriptions.$inferSelect;

interface NewPushSubscription {
    endpoint: string;
    p256dh: string;
    auth: string;
}

// A browser that subscribes again gets new keys for the same endpoint, so the row is replaced, never doubled.
// The cap keeps a client that sends endless endpoints from filling the table.
const MAX_PUSH_SUBSCRIPTIONS = 20;

class PushSubscriptionStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(): Promise<PushSubscriptionRecord[]> {
        const createdOrder = asc(pushSubscriptions.createdAt);

        return this.database.select()
            .from(pushSubscriptions)
            .orderBy(createdOrder);
    }

    // Returns undefined when the table is full and the endpoint is a new one.
    async save(subscription: NewPushSubscription): Promise<PushSubscriptionRecord | undefined> {
        const existing = await this.list();
        const isKnown = existing.some(record => record.endpoint === subscription.endpoint);

        if (!isKnown && existing.length >= MAX_PUSH_SUBSCRIPTIONS) {
            return undefined;
        }

        const newRecord = { id: randomUUID(), ...subscription, createdAt: this.now() };
        const savedRows = await this.database.insert(pushSubscriptions)
            .values(newRecord)
            .onConflictDoUpdate({
                target: pushSubscriptions.endpoint,
                set: { p256dh: subscription.p256dh, auth: subscription.auth },
            })
            .returning();
        const saved = savedRows[0];

        if (saved === undefined) {
            throw new Error('Saving a push subscription returned no row');
        }

        return saved;
    }

    // Returns false when no subscription has this endpoint.
    async remove(endpoint: string): Promise<boolean> {
        const endpointCondition = eq(pushSubscriptions.endpoint, endpoint);
        const removedRows = await this.database.delete(pushSubscriptions)
            .where(endpointCondition)
            .returning();

        return removedRows.length > 0;
    }
}

export { MAX_PUSH_SUBSCRIPTIONS, PushSubscriptionStore };
export type { NewPushSubscription, PushSubscriptionRecord };
