import { Hono } from 'hono';

import type { BotRoutine } from '../../shared/routineTypes.ts';
import type { WorkChange, WorkSettings } from '../providers/WorkSettings.ts';
import { isProviderId } from '../providers/providerIds.ts';
import type { RoutineRecord, RoutineStore } from '../store/RoutineStore.ts';

interface RoutineErrorResponse {
    error: string;
}

// Routines are listed, changed and removed here by the owner. These routes sit behind the session check.
interface RoutineRoutesOptions {
    routineStore: RoutineStore;
    hasBot: (botId: string) => Promise<boolean>;
    // Refuses a provider, model or effort the routine cannot run on. Returns the problem text.
    checkWorkChoice: WorkSettings['checkChoice'];
}

const BOT_NOT_FOUND: RoutineErrorResponse = { error: 'No bot has this id.' };
const ROUTINE_NOT_FOUND: RoutineErrorResponse = { error: 'This bot has no routine with this id.' };
const WORK_BODY_ERROR: RoutineErrorResponse = { error: 'Send a JSON body with a provider, a model and an effort. Each one is text or null, and the provider must be one this app knows.' };

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
        provider: record.provider,
        model: record.model,
        effort: record.effort,
    };
}

// A field must be present. Null means none, and an empty text is refused.
function readWorkText(value: unknown): string | null | undefined {
    if (value === null) {
        return null;
    }

    return typeof value === 'string' && value !== '' ? value : undefined;
}

function readWorkChange(payload: unknown): WorkChange | undefined {
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }

    const { provider, model, effort } = payload as Record<string, unknown>;
    const providerText = readWorkText(provider);
    const modelText = readWorkText(model);
    const effortText = readWorkText(effort);

    if (providerText === undefined || modelText === undefined || effortText === undefined) {
        return undefined;
    }

    if (providerText !== null && !isProviderId(providerText)) {
        return undefined;
    }

    return { provider: providerText, model: modelText, effort: effortText };
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

    routes.put('/api/bots/:id/routines/:routineId/work', async (context) => {
        const botId = context.req.param('id');
        const routineId = context.req.param('routineId');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const change = readWorkChange(payload);

        if (change === undefined) {
            return context.json(WORK_BODY_ERROR, 400);
        }

        if (change.provider !== null) {
            const problem = await options.checkWorkChoice(botId, change);

            if (problem !== undefined) {
                return context.json({ error: problem }, 400);
            }
        }

        const record = await options.routineStore.setWork(botId, routineId, change);

        if (record === undefined) {
            return context.json(ROUTINE_NOT_FOUND, 404);
        }

        const routine = toBotRoutine(record);

        return context.json(routine);
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
