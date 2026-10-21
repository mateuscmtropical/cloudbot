import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { webhooks } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type WebhookRecord = typeof webhooks.$inferSelect;

// The store only sees the hash of a token. The token itself is never passed in or kept.
class WebhookStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<WebhookRecord[]> {
        const botCondition = eq(webhooks.botId, botId);
        const createdOrder = asc(webhooks.createdAt);

        return this.database.select()
            .from(webhooks)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    async add(botId: string, name: string, tokenHash: string): Promise<WebhookRecord> {
        const newWebhook = {
            id: randomUUID(),
            botId,
            name,
            tokenHash,
            createdAt: this.now(),
        };
        const insertedRows = await this.database.insert(webhooks)
            .values(newWebhook)
            .returning();
        const insertedWebhook = insertedRows[0];

        if (insertedWebhook === undefined) {
            throw new Error('Inserting a webhook returned no row');
        }

        return insertedWebhook;
    }

    // Returns undefined when no webhook has this token hash.
    async findByTokenHash(tokenHash: string): Promise<WebhookRecord | undefined> {
        const hashCondition = eq(webhooks.tokenHash, tokenHash);
        const foundRows = await this.database.select()
            .from(webhooks)
            .where(hashCondition);

        return foundRows[0];
    }

    // Returns false when the bot has no webhook with this id.
    async remove(botId: string, webhookId: string): Promise<boolean> {
        const botCondition = eq(webhooks.botId, botId);
        const idCondition = eq(webhooks.id, webhookId);
        const webhookCondition = and(botCondition, idCondition);
        const removedRows = await this.database.delete(webhooks)
            .where(webhookCondition)
            .returning();

        return removedRows.length > 0;
    }
}

export { WebhookStore };
export type { WebhookRecord };
