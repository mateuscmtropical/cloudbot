import { describe, expect, it, vi } from 'vitest';

import type { ModelChoices } from '../models/modelChoices.ts';
import { createProviderRoutes, modelFor } from './createProviderRoutes.ts';
import type { ProviderToolDependencies } from './createProviderTools.ts';
import type { ProviderId } from './providerIds.ts';

const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };

interface TestApp {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
    dependencies: ProviderToolDependencies;
}

function createTestApp(connected: ProviderId[], chat: string | null = null): TestApp {
    const dependencies: ProviderToolDependencies = {
        available: ['claude', 'chatgpt', 'gemini'],
        connected: () => Promise.resolve(connected),
        providerFor: () => Promise.resolve('claude'),
        setProvider: vi.fn(() => Promise.resolve()),
        offerProviders: vi.fn(() => Promise.resolve()),
    };
    const app = createProviderRoutes({
        providers: dependencies,
        modelStore: { get: () => Promise.resolve({ ...NO_CHOICES, chat }) },
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
            .toEqual({ provider: 'claude', label: 'Claude', model: 'sonnet' });
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
        expect(modelFor('claude', null))
            .toBeNull();
    });
});
