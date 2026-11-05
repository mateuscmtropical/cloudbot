import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gt, lt, notInArray } from 'drizzle-orm';

import type { WebhookCall, WebhookCaller } from '../../shared/webhookTypes.ts';
import { webhookCalls, webhooks } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type WebhookRecord = typeof webhooks.$inferSelect;

const CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CALLS_PER_WEBHOOK = 50;

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

    // Returns undefined when the bot has no webhook with this id.
    async setRules(botId: string, webhookId: string, rules: Record<string, string>): Promise<WebhookRecord | undefined> {
        const botCondition = eq(webhooks.botId, botId);
        const idCondition = eq(webhooks.id, webhookId);
        const webhookCondition = and(botCondition, idCondition);
        const updatedRows = await this.database.update(webhooks)
            .set({ rules })
            .where(webhookCondition)
            .returning();

        return updatedRows[0];
    }

    // Notes a call and removes what passed the retention, of every webhook, and what is past the limit of this one.
    async addCall(webhookId: string, caller: WebhookCaller): Promise<void> {
        const time = this.now();
        const cutoff = time - CALL_RETENTION_MS;
        const newCall = { id: randomUUID(), webhookId, time, provider: caller.provider, event: caller.event, address: caller.address, userAgent: caller.userAgent };
        const webhookCondition = eq(webhookCalls.webhookId, webhookId);
        const newestFirst = desc(webhookCalls.time);
        const keptCalls = this.database.select({ id: webhookCalls.id })
            .from(webhookCalls)
            .where(webhookCondition)
            .orderBy(newestFirst)
            .limit(MAX_CALLS_PER_WEBHOOK);
        const pastLimit = notInArray(webhookCalls.id, keptCalls);
        const pastLimitOfWebhook = and(webhookCondition, pastLimit);
        const pastRetention = lt(webhookCalls.time, cutoff);

        await this.database.insert(webhookCalls)
            .values(newCall);
        await this.database.delete(webhookCalls)
            .where(pastLimitOfWebhook);
        await this.database.delete(webhookCalls)
            .where(pastRetention);
    }

    // The newest first, without any that passed the retention.
    async listCalls(webhookId: string): Promise<WebhookCall[]> {
        const cutoff = this.now() - CALL_RETENTION_MS;
        const webhookCondition = eq(webhookCalls.webhookId, webhookId);
        const freshCondition = gt(webhookCalls.time, cutoff);
        const callCondition = and(webhookCondition, freshCondition);
        const newestFirst = desc(webhookCalls.time);
        const rows = await this.database.select()
            .from(webhookCalls)
            .where(callCondition)
            .orderBy(newestFirst)
            .limit(MAX_CALLS_PER_WEBHOOK);

        return rows.map(row => ({ time: row.time, provider: row.provider, event: row.event ?? undefined, address: row.address ?? undefined, userAgent: row.userAgent ?? undefined }));
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

export { CALL_RETENTION_MS, MAX_CALLS_PER_WEBHOOK, WebhookStore };
export type { WebhookRecord };
