import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { randomMascot, readMascotColor } from '../../shared/mascot.ts';
import type { MascotChoice } from '../../shared/mascot.ts';
import { bots, turnQueue, turnWaits } from './schema.ts';
import type { StoredUploadRecord } from './schema.ts';
import type { AppDatabase, Bot, BotProfile, StoreOptions } from './types.ts';

// One message waiting for its turn, in run order.
interface QueuedTurnRecord {
    id: string;
    botId: string;
    position: number;
    messageId: string | null;
    text: string;
    uploads: StoredUploadRecord[];
    source: 'chat' | 'routine' | 'checkin' | 'webhook' | 'bot';
}

interface UsageWaitRecord {
    botId: string;
    resumeAt: number;
}

class BotStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async create(profile: BotProfile): Promise<Bot> {
        const mascot = randomMascot();
        const newBot = {
            id: randomUUID(),
            name: profile.name,
            title: profile.title,
            description: profile.description,
            sessionId: null,
            createdAt: this.now(),
            mascotColor: mascot.color,
            mascotShape: mascot.shape,
        };
        const insertedRows = await this.database.insert(bots)
            .values(newBot)
            .returning();
        const insertedBot = insertedRows[0];

        if (insertedBot === undefined) {
            throw new Error('Inserting a bot returned no row');
        }

        return { ...insertedBot, mascotColor: readMascotColor(insertedBot.mascotColor) };
    }

    // Removes the bot row. Every table that keeps per-bot rows cascades from it, so they go too.
    async delete(botId: string): Promise<void> {
        const botCondition = eq(bots.id, botId);

        await this.database.delete(bots)
            .where(botCondition);
    }

    async getById(botId: string): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);
        const rows = await this.database.select()
            .from(bots)
            .where(botCondition);
        const bot = rows[0];

        if (bot === undefined) {
            return undefined;
        }

        return { ...bot, mascotColor: readMascotColor(bot.mascotColor) };
    }

    async list(): Promise<Bot[]> {
        const oldestFirst = asc(bots.createdAt);
        const byIdAscending = asc(bots.id);
        const rows = await this.database.select()
            .from(bots)
            .orderBy(oldestFirst, byIdAscending);

        return rows.map(row => ({ ...row, mascotColor: readMascotColor(row.mascotColor) }));
    }

    // Only the fields present in `changes` are written, so a partial update never overwrites the others.
    async updateProfile(botId: string, changes: Partial<BotProfile>): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);
        const hasChanges = Object.keys(changes).length > 0;

        if (hasChanges) {
            await this.database.update(bots)
                .set(changes)
                .where(botCondition);
        }

        return this.getById(botId);
    }

    // Only the mascot fields present in `changes` are written.
    async updateMascot(botId: string, changes: { color?: MascotChoice['color'] | undefined; shape?: MascotChoice['shape'] | undefined }): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);
        const mascotChanges = {
            ...(changes.color === undefined ? {} : { mascotColor: changes.color }),
            ...(changes.shape === undefined ? {} : { mascotShape: changes.shape }),
        };

        if (Object.keys(mascotChanges).length > 0) {
            await this.database.update(bots)
                .set(mascotChanges)
                .where(botCondition);
        }

        return this.getById(botId);
    }

    async setSessionId(botId: string, sessionId: string | null): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);

        await this.database.update(bots)
            .set({ sessionId })
            .where(botCondition);

        return this.getById(botId);
    }

    // Every queued turn of every bot, in run order. The chat service reads it once at start.
    async listQueuedTurns(): Promise<QueuedTurnRecord[]> {
        const byPosition = asc(turnQueue.position);

        return this.database.select()
            .from(turnQueue)
            .orderBy(byPosition);
    }

    async insertQueuedTurn(record: QueuedTurnRecord): Promise<void> {
        await this.database.insert(turnQueue)
            .values(record);
    }

    async deleteQueuedTurn(queuedTurnId: string): Promise<void> {
        const isQueuedTurn = eq(turnQueue.id, queuedTurnId);

        await this.database.delete(turnQueue)
            .where(isQueuedTurn);
    }

    async deleteQueuedTurnsOfBot(botId: string): Promise<void> {
        const isBotTurn = eq(turnQueue.botId, botId);

        await this.database.delete(turnQueue)
            .where(isBotTurn);
    }

    async listUsageWaits(): Promise<UsageWaitRecord[]> {
        return this.database.select()
            .from(turnWaits);
    }

    async setUsageWait(botId: string, resumeAt: number): Promise<void> {
        await this.database.insert(turnWaits)
            .values({ botId, resumeAt })
            .onConflictDoUpdate({ target: turnWaits.botId, set: { resumeAt } });
    }

    async deleteUsageWait(botId: string): Promise<void> {
        const isUsageWait = eq(turnWaits.botId, botId);

        await this.database.delete(turnWaits)
            .where(isUsageWait);
    }
}

export { BotStore };
export type { QueuedTurnRecord, UsageWaitRecord };
