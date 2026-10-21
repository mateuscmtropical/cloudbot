import { Hono } from 'hono';

import type { ModelStore } from '../store/ModelStore.ts';
import { EFFORT_LEVELS, MODEL_ALIASES, isModelInputError, parseEffortInput, parseModelInput, toEffortFields } from './modelChoices.ts';

interface ModelErrorResponse {
    error: string;
}

// The model and effort choices are owner settings. These routes sit behind the session check. The bot changes them with models_set.
interface ModelRoutesOptions {
    modelStore: Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts'>;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: ModelErrorResponse = { error: 'No bot has this id.' };
const INVALID_JSON: ModelErrorResponse = { error: 'Send a valid JSON body.' };

function createModelRoutes(options: ModelRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/models', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const choices = await options.modelStore.get(botId);
        const efforts = await options.modelStore.getEfforts(botId);
        // The panel builds its selects from these lists, so they are kept in one place on the server.
        const aliases = [...MODEL_ALIASES];
        const effortLevels = [...EFFORT_LEVELS];

        return context.json({ ...choices, ...toEffortFields(efforts), aliases, effortLevels });
    });

    routes.put('/api/bots/:id/models', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        let payload: unknown;

        try {
            payload = await context.req.json();
        } catch {
            return context.json(INVALID_JSON, 400);
        }

        // Both parts are checked before anything is saved, so a refused request changes nothing.
        const parsedModels = parseModelInput(payload);

        if (isModelInputError(parsedModels)) {
            return context.json(parsedModels, 400);
        }

        const parsedEfforts = parseEffortInput(payload);

        if (isModelInputError(parsedEfforts)) {
            return context.json(parsedEfforts, 400);
        }

        await options.modelStore.set(botId, parsedModels);
        await options.modelStore.setEfforts(botId, parsedEfforts);

        return context.json({ ...parsedModels, ...toEffortFields(parsedEfforts) });
    });

    return routes;
}

export { createModelRoutes };
export type { ModelRoutesOptions };
