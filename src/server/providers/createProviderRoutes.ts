import { Hono } from 'hono';

import type { BotProviderSummary, ProviderChoiceSummary, ProviderConnectResponse } from '../../shared/providerTypes.ts';
import { isClaudeModel } from '../models/modelChoices.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { ProviderToolDependencies } from './createProviderTools.ts';
import { PROVIDER_LABELS, isProviderId } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

interface ProviderErrorResponse {
    error: string;
}

// The provider routes are owner settings behind the session check. The bot changes its own provider with provider_use.
interface ProviderRoutesOptions {
    providers: ProviderToolDependencies;
    modelStore: Pick<ModelStore, 'get'>;
    hasBot: (botId: string) => Promise<boolean>;
    // The bot whose chat holds the sign-in of a provider.
    setupBotId: string;
}

const BOT_NOT_FOUND: ProviderErrorResponse = { error: 'No bot has this id.' };
const INVALID_BODY: ProviderErrorResponse = { error: 'Send a JSON body with a provider.' };
const UNKNOWN_PROVIDER: ProviderErrorResponse = { error: 'This server does not run that provider.' };
const NOT_CONNECTED: ProviderErrorResponse = { error: 'That provider is not connected. Connect it first.' };

// Only the models a provider takes are shown. The claude models belong to Claude, and gemini- models to Gemini.
function modelFor(provider: ProviderId, chatModel: string | null): string | null {
    if (chatModel === null) {
        return null;
    }

    if (provider === 'claude') {
        return isClaudeModel(chatModel) ? chatModel : null;
    }

    return provider === 'gemini' && chatModel.startsWith('gemini-') ? chatModel : null;
}

async function summarize(options: ProviderRoutesOptions, botId: string): Promise<BotProviderSummary> {
    const provider = await options.providers.providerFor(botId);
    const choices = await options.modelStore.get(botId);

    return { provider, label: PROVIDER_LABELS[provider], model: modelFor(provider, choices.chat) };
}

// A check of the sign-ins can take a minute, since each provider is asked through its own CLI. The answer is kept this long.
const CONNECTED_FRESH_MS = 20_000;

interface ConnectedCheck {
    connected: ProviderId[];
    checkedAt: number;
}

function createProviderRoutes(options: ProviderRoutesOptions): Hono {
    const routes = new Hono();
    let lastCheck: ConnectedCheck | undefined;
    let runningCheck: Promise<ConnectedCheck> | undefined;

    function startCheck(): Promise<ConnectedCheck> {
        if (runningCheck !== undefined) {
            return runningCheck;
        }

        const check = options.providers.connected()
            .then((connected) => {
                lastCheck = { connected, checkedAt: Date.now() };

                return lastCheck;
            })
            .finally(() => {
                runningCheck = undefined;
            });

        runningCheck = check;

        return check;
    }

    // The last answer is used at once, and an old one is checked again in the background. Only the first call waits for the CLIs.
    async function readConnected(): Promise<ProviderId[]> {
        if (lastCheck === undefined) {
            const first = await startCheck();

            return first.connected;
        }

        if (Date.now() - lastCheck.checkedAt > CONNECTED_FRESH_MS) {
            startCheck()
                .catch(() => undefined);
        }

        return lastCheck.connected;
    }

    // Whether a provider is connected is checked with its CLI, which takes time. So the list is its own route, read when the menu opens.
    routes.get('/api/providers', async (context) => {
        const connected = await readConnected();
        const providers: ProviderChoiceSummary[] = options.providers.available.map(id => ({ id, label: PROVIDER_LABELS[id], isConnected: connected.includes(id) }));

        return context.json(providers);
    });

    routes.get('/api/bots/:id/provider', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const summary = await summarize(options, botId);

        return context.json(summary);
    });

    routes.put('/api/bots/:id/provider', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const requested = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).provider : undefined;

        if (typeof requested !== 'string') {
            return context.json(INVALID_BODY, 400);
        }

        if (!isProviderId(requested) || !options.providers.available.includes(requested)) {
            return context.json(UNKNOWN_PROVIDER, 400);
        }

        // A provider the last check saw connected is accepted at once. Otherwise it may have been connected since, so it is checked again.
        const knownConnected = lastCheck?.connected.includes(requested) === true;
        const checked = knownConnected ? undefined : await startCheck();

        if (!knownConnected && checked?.connected.includes(requested) !== true) {
            return context.json(NOT_CONNECTED, 400);
        }

        await options.providers.setProvider(botId, requested);
        const summary = await summarize(options, botId);

        return context.json(summary);
    });

    // The sign-in runs in the chat of the setup bot, as it does for a provider the owner connects there.
    routes.post('/api/providers/connect', async (context) => {
        await options.providers.offerProviders();
        const response: ProviderConnectResponse = { botId: options.setupBotId };

        return context.json(response);
    });

    return routes;
}

export { createProviderRoutes, modelFor };
export type { ProviderRoutesOptions };
