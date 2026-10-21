import { randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import { botRules } from '../store/schema.ts';
import type { RuleKind } from '../store/ruleKinds.ts';
import type { AppDatabase, StoreOptions } from '../store/types.ts';

interface BotRule {
    id: string;
    botId: string;
    kind: RuleKind;
    sentence: string;
    blockedTools: string[];
    createdAt: number;
}

interface NewBotRule {
    kind: RuleKind;
    sentence: string;
    blockedTools: string[];
}

class RuleStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    // Oldest first, so the prompt lists the rules in the order the owner wrote them.
    async listForBot(botId: string): Promise<BotRule[]> {
        const isBotRule = eq(botRules.botId, botId);
        const oldestFirst = asc(botRules.createdAt);
        const byIdAscending = asc(botRules.id);

        return this.database.select()
            .from(botRules)
            .where(isBotRule)
            .orderBy(oldestFirst, byIdAscending);
    }

    async add(botId: string, newRule: NewBotRule): Promise<BotRule> {
        const storedRule: BotRule = { id: randomUUID(), botId, createdAt: this.now(), ...newRule };

        await this.database.insert(botRules)
            .values(storedRule);

        return storedRule;
    }

    // Returns false when no rule of this bot has the id, so one bot cannot remove the rule of another.
    async remove(botId: string, ruleId: string): Promise<boolean> {
        const isRule = eq(botRules.id, ruleId);
        const isBotRule = eq(botRules.botId, botId);
        const isRuleOfBot = and(isRule, isBotRule);
        const removedRows = await this.database.delete(botRules)
            .where(isRuleOfBot)
            .returning({ id: botRules.id });

        return removedRows.length > 0;
    }
}

export { RuleStore };
export type { BotRule, NewBotRule };
