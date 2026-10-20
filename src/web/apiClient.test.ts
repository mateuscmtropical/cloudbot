import { afterEach, describe, expect, it, vi } from 'vitest';

import { listBots, listMessages, stopTurn } from './apiClient.ts';

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(() => Promise.resolve(response));

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
}

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
});
