import { Hono } from 'hono';

import type { ModelStore } from '../store/ModelStore.ts';
import { MODEL_ALIASES, isModelInputError, parseModelInput } from './modelChoices.ts';

interface ModelErrorResponse {
    error: string;
}

// The model choices are owner settings. These routes sit behind the session check, and the bot has no tool for them.
interface ModelRoutesOptions {
    modelStore: Pick<ModelStore, 'get' | 'set'>;
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
        // The panel builds its select from these aliases, so the list is kept in one place on the server.
        const aliases = [...MODEL_ALIASES];

        return context.json({ ...choices, aliases });
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

        const parsed = parseModelInput(payload);

        if (isModelInputError(parsed)) {
            return context.json(parsed, 400);
        }

        await options.modelStore.set(botId, parsed);

        return context.json(parsed);
    });

    return routes;
}

export { createModelRoutes };
export type { ModelRoutesOptions };
