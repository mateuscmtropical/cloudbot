import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, notInArray } from 'drizzle-orm';

import type { IntegrationCommand } from '../../shared/integrations.ts';
import { integrationRuns, integrations } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type IntegrationRecord = typeof integrations.$inferSelect;
type IntegrationRunRecord = typeof integrationRuns.$inferSelect;

interface IntegrationInput {
    name: string;
    entryPath: string;
    command: IntegrationCommand;
    secretName: string | undefined;
    entryHash: string;
}

interface IntegrationRunInput {
    startedAt: number;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
}

// Only the last runs of an integration are kept, so the log stays small.
const MAX_RUNS_PER_INTEGRATION = 20;

// The integrations of each bot, and the last runs of each one.
class IntegrationStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(botId: string): Promise<IntegrationRecord[]> {
        const botCondition = eq(integrations.botId, botId);
        const createdOrder = asc(integrations.createdAt);

        return this.database.select()
            .from(integrations)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    async findByName(botId: string, name: string): Promise<IntegrationRecord | undefined> {
        const botCondition = eq(integrations.botId, botId);
        const nameCondition = eq(integrations.name, name);
        const rowCondition = and(botCondition, nameCondition);
        const rows = await this.database.select()
            .from(integrations)
            .where(rowCondition);

        return rows[0];
    }

    async add(botId: string, input: IntegrationInput): Promise<IntegrationRecord> {
        const timestamp = this.now();
        const row = {
            id: randomUUID(),
            botId,
            ...input,
            secretName: input.secretName ?? null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        await this.database.insert(integrations)
            .values(row);

        const saved = await this.findByName(botId, input.name);

        if (saved === undefined) {
            throw new Error('The integration could not be read back.');
        }

        return saved;
    }

    async update(id: string, input: Omit<IntegrationInput, 'name'>): Promise<void> {
        const idCondition = eq(integrations.id, id);

        await this.database.update(integrations)
            .set({ ...input, secretName: input.secretName ?? null, updatedAt: this.now() })
            .where(idCondition);
    }

    // Removes the integration and its runs. Returns false when no row has the id.
    async remove(id: string): Promise<boolean> {
        const runCondition = eq(integrationRuns.integrationId, id);
        const idCondition = eq(integrations.id, id);

        await this.database.delete(integrationRuns)
            .where(runCondition);

        const removedRows = await this.database.delete(integrations)
            .where(idCondition)
            .returning();

        return removedRows.length > 0;
    }

    async listRuns(integrationId: string): Promise<IntegrationRunRecord[]> {
        const runCondition = eq(integrationRuns.integrationId, integrationId);
        const newestFirst = desc(integrationRuns.startedAt);

        return this.database.select()
            .from(integrationRuns)
            .where(runCondition)
            .orderBy(newestFirst)
            .limit(MAX_RUNS_PER_INTEGRATION);
    }

    // Adds a run, then drops every older run of the integration beyond the last MAX_RUNS_PER_INTEGRATION.
    async addRun(integrationId: string, input: IntegrationRunInput): Promise<void> {
        await this.database.insert(integrationRuns)
            .values({ id: randomUUID(), integrationId, ...input });

        const keptRuns = await this.listRuns(integrationId);
        const keptIds = keptRuns.map(run => run.id);
        const runCondition = eq(integrationRuns.integrationId, integrationId);
        const notKeptCondition = notInArray(integrationRuns.id, keptIds);
        const olderCondition = and(runCondition, notKeptCondition);

        await this.database.delete(integrationRuns)
            .where(olderCondition);
    }
}

export { IntegrationStore, MAX_RUNS_PER_INTEGRATION };
export type { IntegrationInput, IntegrationRecord, IntegrationRunInput, IntegrationRunRecord };
