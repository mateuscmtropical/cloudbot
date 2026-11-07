import { randomUUID } from 'node:crypto';

import { and, asc, eq, lte } from 'drizzle-orm';

import { appTriggers } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type AppTriggerRecord = typeof appTriggers.$inferSelect;

interface NewAppTrigger {
    name: string;
    source: string;
    target: string;
    prompt: string;
    intervalMinutes: number;
}

class AppTriggerStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<AppTriggerRecord[]> {
        const botCondition = eq(appTriggers.botId, botId);
        const createdOrder = asc(appTriggers.createdAt);

        return this.database.select()
            .from(appTriggers)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    // Returns undefined when the bot already has `maxTriggers` triggers.
    async addWithLimit(botId: string, trigger: NewAppTrigger, maxTriggers: number): Promise<AppTriggerRecord | undefined> {
        const existing = await this.list(botId);

        if (existing.length >= maxTriggers) {
            return undefined;
        }

        const createdAt = this.now();
        const insertedRows = await this.database.insert(appTriggers)
            .values({ id: randomUUID(), botId, ...trigger, seen: null, nextCheckAt: createdAt, lastCheckedAt: null, createdAt })
            .returning();
        const inserted = insertedRows[0];

        if (inserted === undefined) {
            throw new Error('Inserting an app trigger returned no row');
        }

        return inserted;
    }

    // Returns false when the bot has no trigger with this id.
    async remove(botId: string, triggerId: string): Promise<boolean> {
        const botCondition = eq(appTriggers.botId, botId);
        const idCondition = eq(appTriggers.id, triggerId);
        const removeCondition = and(botCondition, idCondition);
        const removedRows = await this.database.delete(appTriggers)
            .where(removeCondition)
            .returning();

        return removedRows.length > 0;
    }

    // Triggers whose check time has come, oldest first.
    async listDue(nowMs: number): Promise<AppTriggerRecord[]> {
        const dueCondition = lte(appTriggers.nextCheckAt, nowMs);
        const dueOrder = asc(appTriggers.nextCheckAt);

        return this.database.select()
            .from(appTriggers)
            .where(dueCondition)
            .orderBy(dueOrder);
    }

    // Moves the next check before the app is asked, so a crash cannot repeat a check right away.
    async markChecked(triggerId: string, checkedAt: number, nextCheckAt: number): Promise<void> {
        const idCondition = eq(appTriggers.id, triggerId);

        await this.database.update(appTriggers)
            .set({ lastCheckedAt: checkedAt, nextCheckAt })
            .where(idCondition);
    }

    // Keeps the ids already handled, newest first.
    async setSeen(triggerId: string, seen: string[]): Promise<void> {
        const idCondition = eq(appTriggers.id, triggerId);

        await this.database.update(appTriggers)
            .set({ seen })
            .where(idCondition);
    }
}

export { AppTriggerStore };
export type { AppTriggerRecord, NewAppTrigger };
