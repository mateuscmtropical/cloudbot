import { eq } from 'drizzle-orm';

import type { EffortChoices, ModelChoices } from '../models/modelChoices.ts';
import { toEffortChoice } from '../models/modelChoices.ts';
import { botModels } from './schema.ts';
import type { AppDatabase } from './types.ts';

// A bot with no row has no choices, so every kind uses the CLI default.
const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };
const NO_EFFORTS: EffortChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };

class ModelStore {
    private readonly database: AppDatabase;

    constructor(database: AppDatabase) {
        this.database = database;
    }

    async get(botId: string): Promise<ModelChoices> {
        const foundRow = await this.findRow(botId);

        if (foundRow === undefined) {
            return NO_CHOICES;
        }

        return {
            chat: foundRow.chatModel,
            routines: foundRow.routinesModel,
            review: foundRow.reviewModel,
            browsing: foundRow.browsingModel,
            documents: foundRow.documentsModel,
        };
    }

    // Replaces all model choices. The caller validates them first. The efforts stay as they are.
    async set(botId: string, choices: ModelChoices): Promise<void> {
        const changes = {
            chatModel: choices.chat,
            routinesModel: choices.routines,
            reviewModel: choices.review,
            browsingModel: choices.browsing,
            documentsModel: choices.documents,
        };

        await this.database.insert(botModels)
            .values({ botId, ...changes })
            .onConflictDoUpdate({ target: botModels.botId, set: changes });
    }

    async getEfforts(botId: string): Promise<EffortChoices> {
        const foundRow = await this.findRow(botId);

        if (foundRow === undefined) {
            return NO_EFFORTS;
        }

        return {
            chat: toEffortChoice(foundRow.chatEffort),
            routines: toEffortChoice(foundRow.routinesEffort),
            review: toEffortChoice(foundRow.reviewEffort),
            browsing: toEffortChoice(foundRow.browsingEffort),
            documents: toEffortChoice(foundRow.documentsEffort),
        };
    }

    // Replaces all efforts. The caller validates them first. The models stay as they are.
    async setEfforts(botId: string, efforts: EffortChoices): Promise<void> {
        const changes = {
            chatEffort: efforts.chat,
            routinesEffort: efforts.routines,
            reviewEffort: efforts.review,
            browsingEffort: efforts.browsing,
            documentsEffort: efforts.documents,
        };

        await this.database.insert(botModels)
            .values({ botId, ...changes })
            .onConflictDoUpdate({ target: botModels.botId, set: changes });
    }

    private async findRow(botId: string): Promise<typeof botModels.$inferSelect | undefined> {
        const botCondition = eq(botModels.botId, botId);
        const foundRows = await this.database.select()
            .from(botModels)
            .where(botCondition);

        return foundRows[0];
    }
}

export { ModelStore };
