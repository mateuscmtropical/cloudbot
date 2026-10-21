import { eq } from 'drizzle-orm';

import type { ModelChoices } from '../models/modelChoices.ts';
import { botModels } from './schema.ts';
import type { AppDatabase } from './types.ts';

// A bot with no row has no choices, so every kind uses the CLI default.
const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null };

class ModelStore {
    private readonly database: AppDatabase;

    constructor(database: AppDatabase) {
        this.database = database;
    }

    async get(botId: string): Promise<ModelChoices> {
        const botCondition = eq(botModels.botId, botId);
        const foundRows = await this.database.select()
            .from(botModels)
            .where(botCondition);
        const foundRow = foundRows[0];

        if (foundRow === undefined) {
            return NO_CHOICES;
        }

        return {
            chat: foundRow.chatModel,
            routines: foundRow.routinesModel,
            review: foundRow.reviewModel,
        };
    }

    // Replaces all three choices. The caller validates them first.
    async set(botId: string, choices: ModelChoices): Promise<void> {
        const changes = {
            chatModel: choices.chat,
            routinesModel: choices.routines,
            reviewModel: choices.review,
        };

        await this.database.insert(botModels)
            .values({ botId, ...changes })
            .onConflictDoUpdate({ target: botModels.botId, set: changes });
    }
}

export { ModelStore };
