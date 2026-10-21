import { describe, expect, it } from 'vitest';

import type { ModelChoices } from './modelChoices.ts';
import { createModelRoutes } from './createModelRoutes.ts';
import type { ModelStore } from '../store/ModelStore.ts';

const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };

// Keeps the choices in memory, so the routes are tested without the database.
function createFakeStore(): Pick<ModelStore, 'get' | 'set'> & { saved: Map<string, ModelChoices> } {
    const saved = new Map<string, ModelChoices>();

    return {
        saved,
        get: (botId: string) => Promise.resolve(saved.get(botId) ?? NO_CHOICES),
        set: (botId: string, choices: ModelChoices) => {
            saved.set(botId, choices);

            return Promise.resolve();
        },
    };
}

function createTestApp(knownBotIds: string[]): { request: (path: string, init?: RequestInit) => Response | Promise<Response>; store: ReturnType<typeof createFakeStore> } {
    const store = createFakeStore();
    const app = createModelRoutes({
        modelStore: store,
        hasBot: botId => Promise.resolve(knownBotIds.includes(botId)),
    });

    return { request: (path, init) => app.request(path, init), store };
}

describe('model routes', () => {
    it('answers the choices of a bot with none set', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual(NO_CHOICES);
    });

    it('answers 404 for a bot that does not exist', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/missing/models');

        expect(response.status)
            .toBe(404);
    });

    it('saves valid choices and answers them', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat: 'haiku', routines: 'claude-sonnet-4-5' }),
        });

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: null, browsing: null, documents: null });
        expect(store.saved.get('bot-1'))
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: null, browsing: null, documents: null });
    });

    it('refuses an unknown model and saves nothing', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ review: 'gpt-4o', browsing: null, documents: null }),
        });

        expect(response.status)
            .toBe(400);
        expect(await response.json())
            .toHaveProperty('error', expect.stringContaining('The review model'));
        expect(store.saved.size)
            .toBe(0);
    });

    it('refuses a body that is not JSON', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json',
        });

        expect(response.status)
            .toBe(400);
    });

    it('saves a helper choice next to the model choices', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ browsing: 'haiku' }),
        });

        expect(response.status)
            .toBe(200);
        expect(store.saved.get('bot-1'))
            .toEqual({ chat: null, routines: null, review: null, browsing: 'haiku', documents: null });
    });

    it('answers 404 when saving choices for a bot that does not exist', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/missing/models', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });

        expect(response.status)
            .toBe(404);
    });
});
