import { Hono } from 'hono';

import { WORK_KINDS } from './WorkSettings.ts';
import type { WorkChange, WorkKind, WorkSettings } from './WorkSettings.ts';
import { isProviderId } from './providerIds.ts';

interface WorkSettingsRoutesOptions {
    workSettings: Pick<WorkSettings, 'describe' | 'save'>;
    hasBot: (botId: string) => Promise<boolean>;
}

function isWorkKind(value: string): value is WorkKind {
    return (WORK_KINDS as readonly string[]).includes(value);
}

function readNullableText(value: unknown): string | null | undefined {
    if (value === null || value === undefined) {
        return null;
    }

    return typeof value === 'string' && value !== '' ? value : undefined;
}

function readChange(payload: unknown): WorkChange | undefined {
    if (typeof payload !== 'object' || payload === null) {
        return undefined;
    }

    const { provider, model, effort } = payload as Record<string, unknown>;
    const providerText = readNullableText(provider);
    const modelText = readNullableText(model);
    const effortText = readNullableText(effort);

    if (providerText === undefined || modelText === undefined || effortText === undefined) {
        return undefined;
    }

    if (providerText !== null && !isProviderId(providerText)) {
        return undefined;
    }

    return { provider: providerText, model: modelText, effort: effortText };
}

// The owner's choices for each kind of work, behind the session check. The bot changes them with work_settings_set.
function createWorkSettingsRoutes(options: WorkSettingsRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/work', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json({ error: 'No bot has this id.' }, 404);
        }

        const summaries = await options.workSettings.describe(botId);

        return context.json(summaries);
    });

    routes.put('/api/bots/:id/work/:kind', async (context) => {
        const botId = context.req.param('id');
        const kind = context.req.param('kind');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot || !isWorkKind(kind)) {
            return context.json({ error: 'No bot has this id and kind of work.' }, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const change = readChange(payload);

        if (change === undefined) {
            return context.json({ error: 'Send a JSON body with a provider, a model and an effort.' }, 400);
        }

        const problem = await options.workSettings.save(botId, kind, change);

        if (problem !== undefined) {
            return context.json({ error: problem }, 400);
        }

        const summaries = await options.workSettings.describe(botId);

        return context.json(summaries);
    });

    return routes;
}

export { createWorkSettingsRoutes };
