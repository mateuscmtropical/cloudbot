import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { botRules } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type BotRuleKind = 'allow' | 'block';

interface BotRuleRecord {
    id: string;
    botId: string;
    kind: BotRuleKind;
    text: string;
    blockedTools: string[];
    createdAt: number;
}

interface NewBotRule {
    kind: BotRuleKind;
    text: string;
    blockedTools: string[];
}

class RuleStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    // Oldest first, so the prompt lists the rules in the order the owner added them.
    async list(botId: string): Promise<BotRuleRecord[]> {
        const botCondition = eq(botRules.botId, botId);
        const createdOrder = asc(botRules.createdAt);

        return this.database.select()
            .from(botRules)
            .where(botCondition)
            .orderBy(createdOrder);
    }

    async add(botId: string, rule: NewBotRule): Promise<BotRuleRecord> {
        const newRule = { id: randomUUID(), botId, ...rule, createdAt: this.now() };
        const insertedRows = await this.database.insert(botRules)
            .values(newRule)
            .returning();
        const insertedRule = insertedRows[0];

        if (insertedRule === undefined) {
            throw new Error('Inserting a rule returned no row');
        }

        return insertedRule;
    }

    // Returns false when the bot has no rule with this id.
    async remove(botId: string, ruleId: string): Promise<boolean> {
        const botCondition = eq(botRules.botId, botId);
        const idCondition = eq(botRules.id, ruleId);
        const ruleCondition = and(botCondition, idCondition);
        const removedRows = await this.database.delete(botRules)
            .where(ruleCondition)
            .returning();

        return removedRows.length > 0;
    }
}

export { RuleStore };
export type { BotRuleKind, BotRuleRecord, NewBotRule };
