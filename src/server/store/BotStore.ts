import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { bots } from './schema.ts';
import type { AppDatabase, Bot, BotProfile, StoreOptions } from './types.ts';

class BotStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async create(profile: BotProfile): Promise<Bot> {
        const newBot = {
            id: randomUUID(),
            name: profile.name,
            title: profile.title,
            description: profile.description,
            sessionId: null,
            createdAt: this.now(),
        };
        const insertedRows = await this.database.insert(bots)
            .values(newBot)
            .returning();
        const insertedBot = insertedRows[0];

        if (insertedBot === undefined) {
            throw new Error('Inserting a bot returned no row');
        }

        return insertedBot;
    }

    async getById(botId: string): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);
        const rows = await this.database.select()
            .from(bots)
            .where(botCondition);

        return rows[0];
    }

    async list(): Promise<Bot[]> {
        const oldestFirst = asc(bots.createdAt);
        const byIdAscending = asc(bots.id);
        const rows = await this.database.select()
            .from(bots)
            .orderBy(oldestFirst, byIdAscending);

        return rows;
    }

    async updateProfile(botId: string, profile: BotProfile): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);

        await this.database.update(bots)
            .set({ name: profile.name, title: profile.title, description: profile.description })
            .where(botCondition);

        return this.getById(botId);
    }

    async setSessionId(botId: string, sessionId: string | null): Promise<Bot | undefined> {
        const botCondition = eq(bots.id, botId);

        await this.database.update(bots)
            .set({ sessionId })
            .where(botCondition);

        return this.getById(botId);
    }
}

export { BotStore };
