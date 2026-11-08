import { Hono } from 'hono';

import { isPermissionMode } from '../../shared/permissionModes.ts';
import type { PermissionMode } from '../../shared/permissionModes.ts';
import type { BotProviderSummary, ProviderChoiceSummary, ProviderConnectResponse } from '../../shared/providerTypes.ts';
import { EFFORT_LEVELS, isClaudeModel, isEffortLevel } from '../models/modelChoices.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import { ConnectedProviders } from './ConnectedProviders.ts';
import type { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';
import { claudeModelOptions } from './WorkSettings.ts';
import type { WorkSettings } from './WorkSettings.ts';
import type { ProviderToolDependencies } from './createProviderTools.ts';
import { PROVIDER_LABELS, isProviderId } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

interface ProviderErrorResponse {
    error: string;
}

// The provider routes are owner settings behind the session check. The bot changes its own provider with provider_use.
interface ProviderRoutesOptions {
    providers: ProviderToolDependencies;
    modelStore: Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts' | 'getProviderChoice' | 'setProviderChoice'>;
    modelCatalogs?: ProviderModelCatalogs | undefined;
    hasBot: (botId: string) => Promise<boolean>;
    // Only the owner changes the mode, here behind the session check. No bot tool reaches it, so a page cannot talk a bot into YOLO.
    permissionModes: {
        get: (botId: string) => Promise<PermissionMode>;
        set: (botId: string, mode: PermissionMode) => Promise<void>;
    };
    // The bot whose chat holds the sign-in of a provider.
    setupBotId: string;
    // Knows the real name of a default model once the provider reported it.
    workSettings?: Pick<WorkSettings, 'defaultModelName'>;
}

const BOT_NOT_FOUND: ProviderErrorResponse = { error: 'No bot has this id.' };
const INVALID_BODY: ProviderErrorResponse = { error: 'Send a JSON body with a provider.' };
const UNKNOWN_PROVIDER: ProviderErrorResponse = { error: 'This server does not run that provider.' };
const NOT_CONNECTED: ProviderErrorResponse = { error: 'That provider is not connected. Connect it first.' };
const NO_MODEL_OPTIONS: ProviderErrorResponse = { error: 'This provider does not advertise selectable models.' };
const INVALID_MODEL_CHOICE: ProviderErrorResponse = { error: 'Choose a model from the current provider list.' };
const INVALID_EFFORT_CHOICE: ProviderErrorResponse = { error: 'Choose an effort offered for the selected model.' };
const INVALID_PERMISSION_MODE: ProviderErrorResponse = { error: 'Send a JSON body with a mode: ask, auto or yolo.' };

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

// The choices of Claude live in the bot's chat model and effort. Other providers keep theirs per provider.
async function summarizeClaude(options: ProviderRoutesOptions, botId: string): Promise<BotProviderSummary> {
    const choices = await options.modelStore.get(botId);
    const efforts = await options.modelStore.getEfforts(botId);
    const model = modelFor('claude', choices.chat);
    const defaultName = await options.workSettings?.defaultModelName('claude');
    const permissionMode = await options.permissionModes.get(botId);

    return {
        provider: 'claude',
        label: PROVIDER_LABELS.claude,
        model: model ?? defaultName ?? null,
        modelOptions: claudeModelOptions(model),
        selectedModel: model,
        selectedEffort: efforts.chat,
        effortOptions: [...EFFORT_LEVELS],
        permissionMode,
    };
}

async function saveClaudeChoice(options: ProviderRoutesOptions, botId: string, fields: Record<string, unknown>): Promise<ProviderErrorResponse | undefined> {
    const { model, effort } = fields;

    if (model !== undefined && model !== null && (typeof model !== 'string' || !isClaudeModel(model))) {
        return INVALID_MODEL_CHOICE;
    }

    if (effort !== undefined && effort !== null && !isEffortLevel(effort)) {
        return INVALID_EFFORT_CHOICE;
    }

    if (model !== undefined) {
        const choices = await options.modelStore.get(botId);

        await options.modelStore.set(botId, { ...choices, chat: model });
    }

    if (effort !== undefined) {
        const efforts = await options.modelStore.getEfforts(botId);

        await options.modelStore.setEfforts(botId, { ...efforts, chat: effort });
    }

    return undefined;
}

async function summarize(options: ProviderRoutesOptions, botId: string): Promise<BotProviderSummary> {
    const provider = await options.providers.providerFor(botId);

    if (provider === 'claude') {
        return summarizeClaude(options, botId);
    }

    const choices = await options.modelStore.get(botId);
    const providerChoice = await options.modelStore.getProviderChoice(botId, provider);
    const catalog = options.modelCatalogs?.get(provider);
    const legacyGemini = provider === 'gemini' && choices.chat?.startsWith('gemini-') === true ? choices.chat : null;
    const selectedModel = providerChoice?.model ?? null;
    const savedDefaultIsOffered = catalog !== undefined && providerChoice?.defaultModel !== null && providerChoice?.defaultModel !== undefined
        && catalog.models.some(option => option.id === providerChoice.defaultModel);
    const providerDefaultModel = savedDefaultIsOffered ? providerChoice.defaultModel : catalog?.defaultModel ?? providerChoice?.defaultModel ?? null;
    const hasSelectableModels = (catalog?.models.length ?? 0) > 0;
    const model = providerChoice !== undefined && !hasSelectableModels
        ? null
        : providerChoice === undefined ? legacyGemini ?? providerDefaultModel : selectedModel ?? providerDefaultModel;
    const selectedOption = catalog?.models.find(option => option.id === (selectedModel ?? providerDefaultModel));
    const permissionMode = await options.permissionModes.get(botId);

    return {
        provider,
        label: PROVIDER_LABELS[provider],
        model,
        modelOptions: catalog?.models ?? [],
        selectedModel,
        selectedEffort: providerChoice?.effort ?? null,
        effortOptions: selectedOption?.efforts ?? [],
        permissionMode,
    };
}

function createProviderRoutes(options: ProviderRoutesOptions): Hono {
    const routes = new Hono();
    const askProviders = (): Promise<ProviderId[]> => options.providers.checkConnected?.() ?? options.providers.connected();
    const connectedProviders = new ConnectedProviders(askProviders, () => options.providers.connectionVersion?.() ?? 0);

    // Whether a provider is connected is checked with its CLI, which takes time. So the list is its own route, read when the menu opens.
    routes.get('/api/providers', async (context) => {
        const connected = await connectedProviders.read();
        const providers: ProviderChoiceSummary[] = options.providers.available.map(id => ({ id, label: PROVIDER_LABELS[id], isConnected: connected.includes(id) }));

        return context.json(providers);
    });

    // The plan usage of the connected providers, read through their CLIs. It can take several seconds.
    routes.get('/api/providers/usage', async (context) => {
        if (options.providers.usage === undefined) {
            return context.json([]);
        }

        try {
            const usage = await options.providers.usage();

            return context.json(usage);
        } catch {
            return context.json({ error: 'The plan usage could not be read.' }, 500);
        }
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
        const knownConnected = connectedProviders.last()
            ?.includes(requested) === true;
        const checked = knownConnected ? undefined : await connectedProviders.check();

        if (!knownConnected && checked?.includes(requested) !== true) {
            return context.json(NOT_CONNECTED, 400);
        }

        await options.providers.setProvider(botId, requested);
        const summary = await summarize(options, botId);

        return context.json(summary);
    });

    routes.put('/api/bots/:id/provider/permission-mode', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const mode = (payload as { mode?: unknown } | undefined)?.mode;

        if (!isPermissionMode(mode)) {
            return context.json(INVALID_PERMISSION_MODE, 400);
        }

        await options.permissionModes.set(botId, mode);
        const summary = await summarize(options, botId);

        return context.json(summary);
    });

    routes.put('/api/bots/:id/provider/model', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const provider = await options.providers.providerFor(botId);
        const catalog = options.modelCatalogs?.get(provider);

        if (provider !== 'claude' && (catalog === undefined || catalog.models.length === 0)) {
            return context.json(NO_MODEL_OPTIONS, 400);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const fields = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;

        if (fields === undefined || (fields.model === undefined && fields.effort === undefined)) {
            return context.json({ error: 'Send a model or effort choice.' }, 400);
        }

        if (provider === 'claude') {
            const refusal = await saveClaudeChoice(options, botId, fields);

            if (refusal !== undefined) {
                return context.json(refusal, 400);
            }

            const claudeSummary = await summarize(options, botId);

            return context.json(claudeSummary);
        }

        if (catalog === undefined) {
            return context.json(NO_MODEL_OPTIONS, 400);
        }

        if (fields.model !== undefined && fields.model !== null && typeof fields.model !== 'string') {
            return context.json(INVALID_MODEL_CHOICE, 400);
        }

        if (fields.effort !== undefined && fields.effort !== null && typeof fields.effort !== 'string') {
            return context.json(INVALID_EFFORT_CHOICE, 400);
        }

        const stored = await options.modelStore.getProviderChoice(botId, provider);
        const model = fields.model === undefined ? stored?.model ?? null : fields.model;
        const storedDefaultIsOffered = stored?.defaultModel !== null && stored?.defaultModel !== undefined
            && catalog.models.some(option => option.id === stored.defaultModel);
        const defaultModel = storedDefaultIsOffered ? stored.defaultModel : catalog.defaultModel;
        const selectedModel = model ?? defaultModel;
        const selectedOption = catalog.models.find(option => option.id === selectedModel);

        if (model !== null && selectedOption === undefined) {
            return context.json(INVALID_MODEL_CHOICE, 400);
        }

        const effort = fields.effort === undefined ? stored?.effort ?? null : fields.effort;

        if (effort !== null && selectedOption?.efforts.includes(effort) !== true) {
            return context.json(INVALID_EFFORT_CHOICE, 400);
        }

        const defaultEffort = [selectedOption?.defaultEffort, stored?.defaultEffort, catalog.defaultEffort]
            .find(candidate => candidate !== null && candidate !== undefined && selectedOption?.efforts.includes(candidate)) ?? null;

        await options.modelStore.setProviderChoice(botId, provider, {
            model,
            effort,
            defaultModel,
            defaultEffort,
        });
        const summary = await summarize(options, botId);

        return context.json(summary);
    });

    // The sign-in runs in the chat of the setup bot, as it does for a provider the owner connects there.
    // A provider in the body goes straight to its sign-in. Without one, the chat asks which provider.
    routes.post('/api/providers/connect', async (context) => {
        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const requested = (payload as { provider?: unknown } | undefined)?.provider;
        const picked = typeof requested === 'string' && isProviderId(requested) && options.providers.available.includes(requested) ? requested : undefined;

        if (requested !== undefined && picked === undefined) {
            return context.json(UNKNOWN_PROVIDER, 400);
        }

        await options.providers.offerProviders(picked);
        const response: ProviderConnectResponse = { botId: options.setupBotId };

        return context.json(response);
    });

    return routes;
}

export { createProviderRoutes, modelFor };
export type { ProviderRoutesOptions };
