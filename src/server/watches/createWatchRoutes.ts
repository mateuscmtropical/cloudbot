import { Hono } from 'hono';

import type { BotWatch } from '../../shared/watchTypes.ts';
import type { WatchRecord, WatchStore } from '../store/WatchStore.ts';

interface WatchErrorResponse {
    error: string;
}

// Watches are listed and removed here by the owner, and created by the bot in the chat.
interface WatchRoutesOptions {
    watchStore: WatchStore;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: WatchErrorResponse = { error: 'No bot has this id.' };
const WATCH_NOT_FOUND: WatchErrorResponse = { error: 'This bot has no page watch with this id.' };

// The stored hash and the last text are never sent out.
function toBotWatch(record: WatchRecord): BotWatch {
    return {
        id: record.id,
        name: record.name,
        url: record.url,
        intervalMinutes: record.intervalMinutes,
        keyword: record.keyword,
        lastCheckedAt: record.lastCheckedAt,
        nextCheckAt: record.nextCheckAt,
        createdAt: record.createdAt,
    };
}

// These routes sit behind the session check.
function createWatchRoutes(options: WatchRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/watches', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.watchStore.list(botId);

        const botWatches = records.map(toBotWatch);

        return context.json(botWatches);
    });

    routes.delete('/api/bots/:id/watches/:watchId', async (context) => {
        const botId = context.req.param('id');
        const watchId = context.req.param('watchId');
        const isRemoved = await options.watchStore.remove(botId, watchId);

        if (!isRemoved) {
            return context.json(WATCH_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createWatchRoutes, toBotWatch };
export type { BotWatch, WatchRoutesOptions };
