import { afterEach, describe, expect, it, vi } from 'vitest';

import { getModelSettings, listBots, listMessages, listRoutines, removeRoutine, RequestFailedError, saveModelSettings, stopTurn, uploadAttachments } from './apiClient.ts';

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
        const fetchMock = stubFetch(Response.json({ chat: 'haiku', routines: null, review: null, browsing: null, documents: null, aliases: ['haiku'] }));

        const settings = await getModelSettings('bot-1');

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/models', {});
        expect(settings.aliases)
            .toEqual(['haiku']);
    });

    it('saves all five model settings of a bot with one PUT', async () => {
        const fetchMock = stubFetch(Response.json({ chat: 'haiku', routines: null, review: null, browsing: null, documents: null }));
        const settings = { chat: 'haiku', routines: null, review: null, browsing: null, documents: null };

        await saveModelSettings('bot-1', settings);

        expect(fetchMock)
            .toHaveBeenCalledWith('/api/bots/bot-1/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    });
});
