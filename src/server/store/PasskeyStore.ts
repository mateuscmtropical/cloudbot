import { asc, eq } from 'drizzle-orm';

import { passkeys } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

interface PasskeyRecord {
    id: string;
    publicKey: string;
    counter: number;
    transports: string[];
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
}

interface NewPasskey {
    id: string;
    publicKey: string;
    counter: number;
    transports: string[];
    name: string;
}

class PasskeyStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    // Oldest first, so the list reads in the order the devices were added.
    list(): Promise<PasskeyRecord[]> {
        const createdOrder = asc(passkeys.createdAt);

        return this.database.select()
            .from(passkeys)
            .orderBy(createdOrder);
    }

    async get(id: string): Promise<PasskeyRecord | undefined> {
        const idCondition = eq(passkeys.id, id);
        const rows = await this.database.select()
            .from(passkeys)
            .where(idCondition)
            .limit(1);

        return rows[0];
    }

    async add(passkey: NewPasskey): Promise<PasskeyRecord> {
        const row = { ...passkey, createdAt: this.now(), lastUsedAt: null };
        const insertedRows = await this.database.insert(passkeys)
            .values(row)
            .returning();
        const inserted = insertedRows[0];

        if (inserted === undefined) {
            throw new Error('Inserting a passkey returned no row');
        }

        return inserted;
    }

    // Saves the counter the authenticator reported, so a cloned authenticator with an old counter is noticed.
    async markUsed(id: string, counter: number): Promise<void> {
        const idCondition = eq(passkeys.id, id);

        await this.database.update(passkeys)
            .set({ counter, lastUsedAt: this.now() })
            .where(idCondition);
    }

    // Returns false when no passkey has this id.
    async remove(id: string): Promise<boolean> {
        const idCondition = eq(passkeys.id, id);
        const removedRows = await this.database.delete(passkeys)
            .where(idCondition)
            .returning();

        return removedRows.length > 0;
    }
}

export { PasskeyStore };
export type { NewPasskey, PasskeyRecord };
