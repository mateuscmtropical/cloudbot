import { describe, expect, it } from 'vitest';

import type { EffortChoices, ModelChoices } from './modelChoices.ts';
import { createModelRoutes } from './createModelRoutes.ts';
import type { ModelStore } from '../store/ModelStore.ts';

const NO_CHOICES: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };
const NO_EFFORTS: EffortChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };
const NO_EFFORT_FIELDS = { chatEffort: null, routinesEffort: null, reviewEffort: null, browsingEffort: null, documentsEffort: null };
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface FakeStore extends Pick<ModelStore, 'get' | 'set' | 'getEfforts' | 'setEfforts'> {
    saved: Map<string, ModelChoices>;
    savedEfforts: Map<string, EffortChoices>;
}

// Keeps the choices in memory, so the routes are tested without the database.
function createFakeStore(): FakeStore {
    const saved = new Map<string, ModelChoices>();
    const savedEfforts = new Map<string, EffortChoices>();

    return {
        saved,
        savedEfforts,
        get: (botId: string) => Promise.resolve(saved.get(botId) ?? NO_CHOICES),
        set: (botId: string, choices: ModelChoices) => {
            saved.set(botId, choices);

            return Promise.resolve();
        },
        getEfforts: (botId: string) => Promise.resolve(savedEfforts.get(botId) ?? NO_EFFORTS),
        setEfforts: (botId: string, efforts: EffortChoices) => {
            savedEfforts.set(botId, efforts);

            return Promise.resolve();
        },
    };
}

function createTestApp(knownBotIds: string[]): { request: (path: string, init?: RequestInit) => Response | Promise<Response>; store: FakeStore } {
    const store = createFakeStore();
    const app = createModelRoutes({
        modelStore: store,
        hasBot: botId => Promise.resolve(knownBotIds.includes(botId)),
    });

    return { request: (path, init) => app.request(path, init), store };
}

function putJson(body: unknown): RequestInit {
    return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('model routes', () => {
    it('answers the choices and efforts of a bot with none set, with the effort levels', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ ...NO_CHOICES, ...NO_EFFORT_FIELDS, aliases: ['fable', 'opus', 'sonnet', 'haiku'], effortLevels: EFFORT_LEVELS });
    });

    it('answers 404 for a bot that does not exist', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/missing/models');

        expect(response.status)
            .toBe(404);
    });

    it('saves valid choices and efforts and answers them', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', putJson({ chat: 'haiku', routines: 'claude-sonnet-4-5', chatEffort: 'high', routinesEffort: 'max' }));

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({
                chat: 'haiku',
                routines: 'claude-sonnet-4-5',
                review: null,
                browsing: null,
                documents: null,
                chatEffort: 'high',
                routinesEffort: 'max',
                reviewEffort: null,
                browsingEffort: null,
                documentsEffort: null,
            });
        expect(store.saved.get('bot-1'))
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: null, browsing: null, documents: null });
        expect(store.savedEfforts.get('bot-1'))
            .toEqual({ chat: 'high', routines: 'max', review: null, browsing: null, documents: null });
    });

    it('refuses an unknown model and saves nothing', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', putJson({ review: 'gpt-4o', browsing: null, documents: null }));

        expect(response.status)
            .toBe(400);
        expect(await response.json())
            .toHaveProperty('error', expect.stringContaining('The review model'));
        expect(store.saved.size)
            .toBe(0);
    });

    it('refuses an unknown effort level and saves nothing, not even the valid models', async () => {
        const { request, store } = createTestApp(['bot-1']);

        const response = await request('/api/bots/bot-1/models', putJson({ chat: 'haiku', chatEffort: 'extreme' }));

        expect(response.status)
            .toBe(400);
        expect(await response.json())
            .toHaveProperty('error', expect.stringContaining('The chat effort'));
        expect(store.saved.size)
            .toBe(0);
        expect(store.savedEfforts.size)
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

        const response = await request('/api/bots/bot-1/models', putJson({ browsing: 'haiku' }));

        expect(response.status)
            .toBe(200);
        expect(store.saved.get('bot-1'))
            .toEqual({ chat: null, routines: null, review: null, browsing: 'haiku', documents: null });
    });

    it('answers 404 when saving choices for a bot that does not exist', async () => {
        const { request } = createTestApp(['bot-1']);

        const response = await request('/api/bots/missing/models', putJson({}));

        expect(response.status)
            .toBe(404);
    });
});
