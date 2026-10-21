import { Hono } from 'hono';

import type { LimitStore } from '../store/LimitStore.ts';
import { LIMIT_RULES, isLimitInputError, parseLimitInput } from './turnLimits.ts';

interface LimitErrorResponse {
    error: string;
}

// The limits are owner settings. These routes sit behind the session check. The bot changes them with limits_set.
interface LimitRoutesOptions {
    limitStore: Pick<LimitStore, 'get' | 'set'>;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: LimitErrorResponse = { error: 'No bot has this id.' };
const INVALID_JSON: LimitErrorResponse = { error: 'Send a valid JSON body.' };

function createLimitRoutes(options: LimitRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/limits', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const limits = await options.limitStore.get(botId);

        // The panel builds its inputs from these bounds, so they are kept in one place on the server.
        return context.json({ ...limits, bounds: LIMIT_RULES });
    });

    routes.put('/api/bots/:id/limits', async (context) => {
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

        const parsed = parseLimitInput(payload);

        if (isLimitInputError(parsed)) {
            return context.json(parsed, 400);
        }

        await options.limitStore.set(botId, parsed);

        return context.json(parsed);
    });

    return routes;
}

export { createLimitRoutes };
export type { LimitRoutesOptions };
