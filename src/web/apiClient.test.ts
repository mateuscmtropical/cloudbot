import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebhook, getLimits, getModelSettings, listBots, listMessages, listRoutines, listWebhooks, removeRoutine, removeWebhook, RequestFailedError, saveLimits, saveModelSettings, stopTurn, uploadAttachments } from './apiClient.ts';

const NO_SETTINGS = {
    chat: null,
    routines: null,
    review: null,
    browsing: null,
    documents: null,
    chatEffort: null,
    routinesEffort: null,
    reviewEffort: null,
    browsingEffort: null,
    documentsEffort: null,
};

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() => Promise.resolve(response));

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

describe('uploadAttachments', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('carries the error text the server sent with a refused upload', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'Send at most 10 files at once.' }), { status: 400 }))));

        const uploadPromise = uploadAttachments('bot-1', [new File(['x'], 'a.txt')]);
        const failure = await uploadPromise
            .catch((error: unknown) => error);

        expect(failure)
            .toBeInstanceOf(RequestFailedError);
        expect(failure instanceof RequestFailedError ? failure.serverMessage : undefined)
            .toBe('Send at most 10 files at once.');
    });
});

describe('webhook calls', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists the webhooks of a bot', async () => {
        const fetchMock = stubFetch(Response.json([{ id: 'w1', name: 'Deploy', createdAt: 5 }]));

        expect(await listWebhooks('bot-1'))
            .toEqual([{ id: 'w1', name: 'Deploy', createdAt: 5 }]);
        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/webhooks', {});
    });

    it('creates a webhook with its name and returns the URL the server gave once', async () => {
        const fetchMock = stubFetch(Response.json({ id: 'w1', name: 'Deploy', createdAt: 5, url: 'https://bot.example.com/hooks/t' }, { status: 201 }));

        const created = await createWebhook('bot-1', 'Deploy');

        expect(created.url)
            .toBe('https://bot.example.com/hooks/t');
        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Deploy' }) });
    });

    it('carries the error text the server sent when a webhook cannot be created', async () => {
        stubFetch(Response.json({ error: 'This bot has 10 webhooks. Delete one first.' }, { status: 400 }));

        const failure = await createWebhook('bot-1', 'Deploy')
            .catch((error: unknown) => error);

        expect(failure instanceof RequestFailedError ? failure.serverMessage : undefined)
            .toBe('This bot has 10 webhooks. Delete one first.');
    });

    it('removes a webhook by its id', async () => {
        const fetchMock = stubFetch(new Response(null, { status: 204 }));

        await removeWebhook('bot 1', 'w/1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot%201/webhooks/w%2F1', { method: 'DELETE' });
    });
});

describe('apiClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists bots from the api route', async () => {
        const fetchMock = stubFetch(Response.json([{ id: 'bot-1' }]));

        const bots = await listBots();

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots', {});
        expect(bots)
            .toEqual([{ id: 'bot-1' }]);
    });

    it('throws when the server answers with an error', async () => {
        stubFetch(new Response(null, { status: 500 }));

        await expect(listBots())
            .rejects
            .toThrow('status 500');
    });

    it('posts a stop request for the bot id', async () => {
        const fetchMock = stubFetch(new Response(null, { status: 204 }));

        await stopTurn('bot/1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot%2F1/stop', { method: 'POST' });
    });

    it('asks for the page before a sequence with a limit', async () => {
        const fetchMock = stubFetch(Response.json([]));

        await listMessages('bot-1', { beforeSequence: 51, limit: 50 });

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/messages?before=51&limit=50', {});
    });

    it('sends no query string when no page is asked for', async () => {
        const fetchMock = stubFetch(Response.json([]));

        await listMessages('bot-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/messages', {});
    });

    it('lists the routines of a bot', async () => {
        const fetchMock = stubFetch(Response.json([{ id: 'routine-1' }]));

        const routines = await listRoutines('bot-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/routines', {});
        expect(routines)
            .toEqual([{ id: 'routine-1' }]);
    });

    it('deletes a routine by its bot and routine id', async () => {
        const fetchMock = stubFetch(new Response(null, { status: 204 }));

        await removeRoutine('bot/1', 'routine-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot%2F1/routines/routine-1', { method: 'DELETE' });
    });

    it('reads the model settings and the aliases of a bot', async () => {
        const fetchMock = stubFetch(Response.json({ ...NO_SETTINGS, chat: 'haiku', aliases: ['haiku'], effortLevels: ['low', 'max'] }));

        const settings = await getModelSettings('bot-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/models', {});
        expect(settings.aliases)
            .toEqual(['haiku']);
        expect(settings.effortLevels)
            .toEqual(['low', 'max']);
    });

    it('saves all ten model and effort settings of a bot with one PUT', async () => {
        const settings = { ...NO_SETTINGS, chat: 'haiku', chatEffort: 'high' as const };
        const fetchMock = stubFetch(Response.json(settings));

        await saveModelSettings('bot-1', settings);

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    });

    it('reads the limits of a bot with their bounds', async () => {
        const fetchMock = stubFetch(Response.json({
            chat: { minutes: 10, usd: null, steps: null },
            routines: { minutes: null, usd: null, steps: null },
            bounds: { minutes: { min: 1, max: 1440, isWhole: true } },
        }));

        const limits = await getLimits('bot-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/limits', {});
        expect(limits.chat.minutes)
            .toBe(10);
        expect(limits.bounds.minutes.max)
            .toBe(1440);
    });

    it('saves the limits of a bot with one PUT', async () => {
        const limits = { chat: { minutes: 5, usd: 0.5, steps: null }, routines: { minutes: null, usd: null, steps: null } };
        const fetchMock = stubFetch(Response.json(limits));

        await saveLimits('bot-1', limits);

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/limits', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(limits) });
    });
});
