import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte } from 'drizzle-orm';

import { watches } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type WatchRecord = typeof watches.$inferSelect;

interface NewWatch {
    name: string;
    url: string;
    intervalMinutes: number;
    keyword: string | undefined;
}

interface WatchCheckRecord {
    checkedAt: number;
    nextCheckAt: number;
}

interface WatchTextRecord {
    textHash: string;
    lastText: string;
}

class WatchStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<WatchRecord[]> {
        const botCondition = eq(watches.botId, botId);
        const createdOrder = asc(watches.createdAt);

        return this.database.select()
            .from(watches)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    // Returns undefined when the bot already has `maxWatches` watches.
    async addWithLimit(botId: string, watch: NewWatch, maxWatches: number): Promise<WatchRecord | undefined> {
        const existingWatches = await this.list(botId);

        if (existingWatches.length >= maxWatches) {
            return undefined;
        }

        const createdAt = this.now();
        const newWatch = {
            id: randomUUID(),
            botId,
            ...watch,
            keyword: watch.keyword ?? null,
            textHash: null,
            lastText: null,
            nextCheckAt: createdAt,
            lastCheckedAt: null,
            createdAt,
        };
        const insertedRows = await this.database.insert(watches)
            .values(newWatch)
            .returning();
        const insertedWatch = insertedRows[0];

        if (insertedWatch === undefined) {
            throw new Error('Inserting a watch returned no row');
        }

        return insertedWatch;
    }

    // Returns false when the bot has no watch with this id.
    async remove(botId: string, watchId: string): Promise<boolean> {
        const botCondition = eq(watches.botId, botId);
        const idCondition = eq(watches.id, watchId);
        const watchCondition = and(botCondition, idCondition);
        const removedRows = await this.database.delete(watches)
            .where(watchCondition)
            .returning();

        return removedRows.length > 0;
    }

    // Watches whose check time has come, oldest first.
    async listDue(nowMs: number): Promise<WatchRecord[]> {
        const dueCondition = lte(watches.nextCheckAt, nowMs);
        const dueOrder = asc(watches.nextCheckAt);

        return this.database.select()
            .from(watches)
            .where(dueCondition)
            .orderBy(dueOrder);
    }

    // Moves the next check before the page is fetched, so a crash cannot repeat a check right away.
    async markChecked(watchId: string, record: WatchCheckRecord): Promise<void> {
        const idCondition = eq(watches.id, watchId);

        await this.database.update(watches)
            .set({ lastCheckedAt: record.checkedAt, nextCheckAt: record.nextCheckAt })
            .where(idCondition);
    }

    // Keeps the hash and the capped text of the page as the last seen version.
    async setText(watchId: string, record: WatchTextRecord): Promise<void> {
        const idCondition = eq(watches.id, watchId);

        await this.database.update(watches)
            .set({ textHash: record.textHash, lastText: record.lastText })
            .where(idCondition);
    }
}

export { WatchStore };
export type { NewWatch, WatchRecord };
