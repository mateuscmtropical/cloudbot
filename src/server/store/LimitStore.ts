import { eq } from 'drizzle-orm';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import { NO_LIMITS } from '../limits/turnLimits.ts';
import { botLimits } from './schema.ts';
import type { AppDatabase } from './types.ts';

type LimitRow = typeof botLimits.$inferSelect;

// A bot with no row has no limits.
class LimitStore {
    private readonly database: AppDatabase;

    constructor(database: AppDatabase) {
        this.database = database;
    }

    async get(botId: string): Promise<TurnLimits> {
        const foundRow = await this.findRow(botId);

        if (foundRow === undefined) {
            return NO_LIMITS;
        }

        return {
            chat: { minutes: foundRow.chatMinutes, usd: foundRow.chatUsd, steps: foundRow.chatSteps },
            routines: { minutes: foundRow.routineMinutes, usd: foundRow.routineUsd, steps: foundRow.routineSteps },
        };
    }

    // Replaces all limits. The caller validates them first.
    async set(botId: string, limits: TurnLimits): Promise<void> {
        const changes = toRowChanges(limits);

        await this.database.insert(botLimits)
            .values({ botId, ...changes })
            .onConflictDoUpdate({ target: botLimits.botId, set: changes });
    }

    private async findRow(botId: string): Promise<LimitRow | undefined> {
        const botCondition = eq(botLimits.botId, botId);
        const foundRows = await this.database.select()
            .from(botLimits)
            .where(botCondition);

        return foundRows[0];
    }
}

function toRowChanges(limits: TurnLimits): Omit<LimitRow, 'botId'> {
    return {
        chatMinutes: limits.chat.minutes,
        chatUsd: limits.chat.usd,
        chatSteps: limits.chat.steps,
        routineMinutes: limits.routines.minutes,
        routineUsd: limits.routines.usd,
        routineSteps: limits.routines.steps,
    };
}

export { LimitStore };
