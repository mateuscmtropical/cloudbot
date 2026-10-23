import { describe, expect, it, vi } from 'vitest';

import type { ModelChoices } from '../models/modelChoices.ts';
import { createProviderRoutes, modelFor } from './createProviderRoutes.ts';
import { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';
import type { ProviderModelChoice } from '../store/ModelStore.ts';
import type { ProviderToolDependencies } from './createProviderTools.ts';
import type { ProviderId } from './providerIds.ts';

const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };

interface TestApp {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
    dependencies: ProviderToolDependencies;
}

function createTestApp(connected: ProviderId[], chat: string | null = null, provider: ProviderId = 'claude', modelCatalogs?: ProviderModelCatalogs): TestApp {
    const providerChoices = new Map<string, ProviderModelChoice>();
    const dependencies: ProviderToolDependencies = {
        available: ['claude', 'chatgpt', 'gemini'],
        connected: () => Promise.resolve(connected),
        providerFor: () => Promise.resolve(provider),
        setProvider: vi.fn(() => Promise.resolve()),
        offerProviders: vi.fn(() => Promise.resolve()),
    };
    const app = createProviderRoutes({
        providers: dependencies,
        modelStore: {
            get: () => Promise.resolve({ ...NO_CHOICES, chat }),
            getProviderChoice: (botId, providerId) => Promise.resolve(providerChoices.get(`${botId}:${providerId}`)),
            setProviderChoice: vi.fn((botId: string, providerId: ProviderId, choice: ProviderModelChoice) => {
                providerChoices.set(`${botId}:${providerId}`, choice);

                return Promise.resolve();
            }),
        },
        modelCatalogs,
        hasBot: botId => Promise.resolve(botId === 'bot-1'),
        setupBotId: 'setup-bot',
    });

    return { request: (path, init) => app.request(path, init), dependencies };
}

function putJson(body: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('provider routes', () => {
    it('answers the provider of a bot and its model', async () => {
        const { request } = createTestApp(['claude'], 'sonnet');

        const response = await request('/api/bots/bot-1/provider');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ provider: 'claude', label: 'Claude', model: 'sonnet', modelOptions: [], selectedModel: null, selectedEffort: null, effortOptions: [] });
    });

    it('lists the providers of the server with the state of each', async () => {
        const { request } = createTestApp(['claude', 'gemini']);

        const response = await request('/api/providers');

        expect(await response.json())
            .toEqual([
                { id: 'claude', label: 'Claude', isConnected: true },
                { id: 'chatgpt', label: 'ChatGPT', isConnected: false },
                { id: 'gemini', label: 'Gemini', isConnected: true },
            ]);
    });

    it('checks the sign-ins once for calls close together, and the switch trusts a provider seen as connected', async () => {
        const { request, dependencies } = createTestApp(['claude', 'gemini']);
        const connectedSpy = vi.spyOn(dependencies, 'connected');

        await request('/api/providers');
        await request('/api/providers');
        await request('/api/bots/bot-1/provider', putJson({ provider: 'gemini' }));

        expect(connectedSpy)
            .toHaveBeenCalledTimes(1);
    });

    it('checks again before it refuses a provider the last check saw as not connected', async () => {
        const { request, dependencies } = createTestApp(['claude']);
        const connectedSpy = vi.spyOn(dependencies, 'connected');

        await request('/api/providers');
        connectedSpy.mockResolvedValue(['claude', 'gemini']);
        const response = await request('/api/bots/bot-1/provider', putJson({ provider: 'gemini' }));

        expect(response.status)
            .toBe(200);
        expect(connectedSpy)
            .toHaveBeenCalledTimes(2);
    });

    it('answers 404 for a bot that does not exist', async () => {
        const { request } = createTestApp(['claude']);

        const response = await request('/api/bots/missing/provider');

        expect(response.status)
            .toBe(404);
    });

    it('switches the bot to a connected provider', async () => {
        const { request, dependencies } = createTestApp(['claude', 'gemini']);

        const response = await request('/api/bots/bot-1/provider', putJson({ provider: 'gemini' }));

        expect(response.status)
            .toBe(200);
        expect(dependencies.setProvider)
            .toHaveBeenCalledWith('bot-1', 'gemini');
    });

    it('lists and saves only the model and effort advertised for the current provider', async () => {
        const modelCatalogs = new ProviderModelCatalogs();

        modelCatalogs.set('chatgpt', {
            models: [
                { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low', 'medium'] },
                { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: ['high'] },
            ],
            defaultModel: 'gpt-6-astra',
            defaultEffort: 'high',
        });
        const { request } = createTestApp(['chatgpt'], null, 'chatgpt', modelCatalogs);

        const summary = await request('/api/bots/bot-1/provider');
        const saved = await request('/api/bots/bot-1/provider/model', putJson({ model: 'gpt-6-luna', effort: 'low' }));
        const invalidModel = await request('/api/bots/bot-1/provider/model', putJson({ model: 'sonnet', effort: null }));
        const invalidEffort = await request('/api/bots/bot-1/provider/model', putJson({ model: 'gpt-6-luna', effort: 'high' }));

        expect((await summary.json() as { modelOptions: unknown[] }).modelOptions)
            .toHaveLength(2);
        expect(await saved.json())
            .toMatchObject({ model: 'gpt-6-luna', selectedModel: 'gpt-6-luna', selectedEffort: 'low' });
        expect([invalidModel.status, invalidEffort.status])
            .toEqual([400, 400]);

        modelCatalogs.clear('chatgpt');
        const afterAuthChange = await request('/api/bots/bot-1/provider');

        expect(await afterAuthChange.json())
            .toMatchObject({ model: null, modelOptions: [] });
    });

    it('refuses a provider that is not connected, not on this server or not a provider', async () => {
        const { request, dependencies } = createTestApp(['claude']);

        const notConnected = await request('/api/bots/bot-1/provider', putJson({ provider: 'gemini' }));
        const notOnServer = await request('/api/bots/bot-1/provider', putJson({ provider: 'kimi' }));
        const notAProvider = await request('/api/bots/bot-1/provider', putJson({ provider: 'nothing' }));
        const noBody = await request('/api/bots/bot-1/provider', putJson({}));

        expect([notConnected.status, notOnServer.status, notAProvider.status, noBody.status])
            .toEqual([400, 400, 400, 400]);
        expect(dependencies.setProvider)
            .not
            .toHaveBeenCalled();
    });

    it('posts the provider list in the setup chat and names that bot', async () => {
        const { request, dependencies } = createTestApp(['claude']);

        const response = await request('/api/providers/connect', { method: 'POST' });

        expect(await response.json())
            .toEqual({ botId: 'setup-bot' });
        expect(dependencies.offerProviders)
            .toHaveBeenCalledTimes(1);
    });
});

describe('modelFor', () => {
    it('shows only the models the provider takes', () => {
        expect(modelFor('claude', 'sonnet'))
            .toBe('sonnet');
        expect(modelFor('claude', 'gemini-3.8-flash-low'))
            .toBeNull();
        expect(modelFor('gemini', 'gemini-3.8-flash-low'))
            .toBe('gemini-3.8-flash-low');
        expect(modelFor('gemini', 'sonnet'))
            .toBeNull();
        expect(modelFor('chatgpt', 'sonnet'))
            .toBeNull();
        expect(modelFor('grok', 'sonnet'))
            .toBeNull();
        expect(modelFor('claude', null))
            .toBeNull();
    });
});
