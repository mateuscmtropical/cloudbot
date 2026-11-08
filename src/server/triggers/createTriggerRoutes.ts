import { Hono } from 'hono';

import type { BotTrigger } from '../../shared/triggerTypes.ts';
import type { AppTriggerRecord, AppTriggerStore } from '../store/AppTriggerStore.ts';
import { findTriggerSource } from './triggerSources.ts';

interface TriggerErrorResponse {
    error: string;
}

// Triggers are listed, paused, resumed and removed here by the owner, and created by the bot in the chat.
interface TriggerRoutesOptions {
    triggerStore: AppTriggerStore;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: TriggerErrorResponse = { error: 'No bot has this id.' };
const TRIGGER_NOT_FOUND: TriggerErrorResponse = { error: 'This bot has no app trigger with this id.' };
const ENABLED_BODY_ERROR: TriggerErrorResponse = { error: 'Send a JSON body with isEnabled as true or false.' };

// The seen ids are never sent out.
function toBotTrigger(record: AppTriggerRecord): BotTrigger {
    return {
        id: record.id,
        name: record.name,
        source: record.source,
        sourceLabel: findTriggerSource(record.source)?.label ?? record.source,
        target: record.target,
        prompt: record.prompt,
        intervalMinutes: record.intervalMinutes,
        isEnabled: record.isEnabled,
        lastCheckedAt: record.lastCheckedAt,
        nextCheckAt: record.nextCheckAt,
        createdAt: record.createdAt,
    };
}

function readIsEnabled(payload: unknown): boolean | undefined {
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }

    const { isEnabled } = payload as Record<string, unknown>;

    return typeof isEnabled === 'boolean' ? isEnabled : undefined;
}

// These routes sit behind the session check.
function createTriggerRoutes(options: TriggerRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/triggers', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.triggerStore.list(botId);
        const triggers = records.map(toBotTrigger);

        return context.json(triggers);
    });

    routes.put('/api/bots/:id/triggers/:triggerId/enabled', async (context) => {
        const botId = context.req.param('id');
        const triggerId = context.req.param('triggerId');
        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const isEnabled = readIsEnabled(payload);

        if (isEnabled === undefined) {
            return context.json(ENABLED_BODY_ERROR, 400);
        }

        const record = await options.triggerStore.setEnabled(botId, triggerId, isEnabled);

        if (record === undefined) {
            return context.json(TRIGGER_NOT_FOUND, 404);
        }

        const trigger = toBotTrigger(record);

        return context.json(trigger);
    });

    routes.delete('/api/bots/:id/triggers/:triggerId', async (context) => {
        const botId = context.req.param('id');
        const triggerId = context.req.param('triggerId');
        const isRemoved = await options.triggerStore.remove(botId, triggerId);

        if (!isRemoved) {
            return context.json(TRIGGER_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createTriggerRoutes, toBotTrigger };
export type { TriggerRoutesOptions };
