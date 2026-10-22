import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { botSkills } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

interface BotSkillRecord {
    id: string;
    botId: string;
    name: string;
    description: string;
    text: string;
    createdAt: number;
    updatedAt: number;
}

interface NewBotSkill {
    name: string;
    description: string;
    text: string;
}

class SkillStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    // Sorted by name, so the prompt and the list read the same way every turn.
    async list(botId: string): Promise<BotSkillRecord[]> {
        const botCondition = eq(botSkills.botId, botId);
        const nameOrder = asc(botSkills.name);

        return this.database.select()
            .from(botSkills)
            .where(botCondition)
            .orderBy(nameOrder);
    }

    async get(botId: string, name: string): Promise<BotSkillRecord | undefined> {
        const botCondition = eq(botSkills.botId, botId);
        const nameCondition = eq(botSkills.name, name);
        const skillCondition = and(botCondition, nameCondition);
        const rows = await this.database.select()
            .from(botSkills)
            .where(skillCondition)
            .limit(1);

        return rows[0];
    }

    // A skill with the same name is replaced, so the owner can approve a fixed version under the same name.
    async save(botId: string, skill: NewBotSkill): Promise<BotSkillRecord> {
        const now = this.now();
        const newSkill = { id: randomUUID(), botId, ...skill, createdAt: now, updatedAt: now };
        const changedFields = { description: skill.description, text: skill.text, updatedAt: now };
        const savedRows = await this.database.insert(botSkills)
            .values(newSkill)
            .onConflictDoUpdate({ target: [botSkills.botId, botSkills.name], set: changedFields })
            .returning();
        const savedSkill = savedRows[0];

        if (savedSkill === undefined) {
            throw new Error('Saving a skill returned no row');
        }

        return savedSkill;
    }

    // Returns false when the bot has no skill with this name.
    async remove(botId: string, name: string): Promise<boolean> {
        const botCondition = eq(botSkills.botId, botId);
        const nameCondition = eq(botSkills.name, name);
        const skillCondition = and(botCondition, nameCondition);
        const removedRows = await this.database.delete(botSkills)
            .where(skillCondition)
            .returning();

        return removedRows.length > 0;
    }
}

export { SkillStore };
export type { BotSkillRecord, NewBotSkill };
