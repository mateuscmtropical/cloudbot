import { Hono } from 'hono';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import type { RoutineRecord, RoutineStore } from '../store/RoutineStore.ts';

interface RoutineErrorResponse {
    error: string;
}

// Routines are listed and removed here by the owner. These routes sit behind the session check.
interface RoutineRoutesOptions {
    routineStore: RoutineStore;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: RoutineErrorResponse = { error: 'No bot has this id.' };
const ROUTINE_NOT_FOUND: RoutineErrorResponse = { error: 'This bot has no routine with this id.' };

function toBotRoutine(record: RoutineRecord): BotRoutine {
    return {
        id: record.id,
        name: record.name,
        prompt: record.prompt,
        schedule: record.schedule,
        isEnabled: record.isEnabled,
        isQuiet: record.isQuiet,
        nextRunAt: record.nextRunAt,
        lastRunAt: record.lastRunAt,
    };
}

function createRoutineRoutes(options: RoutineRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/routines', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.routineStore.list(botId);
        const routines = records.map(toBotRoutine);

        return context.json(routines);
    });

    routes.delete('/api/bots/:id/routines/:routineId', async (context) => {
        const botId = context.req.param('id');
        const routineId = context.req.param('routineId');
        const isRemoved = await options.routineStore.remove(botId, routineId);

        if (!isRemoved) {
            return context.json(ROUTINE_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createRoutineRoutes, toBotRoutine };
export type { RoutineRoutesOptions };
