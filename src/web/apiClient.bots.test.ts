import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBot, deleteBot, RequestFailedError } from './apiClient.ts';

describe('bot create and delete calls', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('creates a bot with a POST to the bots route', async () => {
        const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ id: 'bot-3', name: 'New bot' }), { status: 201, headers: { 'content-type': 'application/json' } })));

        vi.stubGlobal('fetch', fetchMock);

        const created = await createBot();

        expect(created.id)
            .toBe('bot-3');
        expect(fetchMock.mock.calls[0]?.[0])
            .toBe('/api/bots');
        expect(fetchMock.mock.calls[0]?.[1])
            .toMatchObject({ method: 'POST' });
    });

    it('deletes a bot with a DELETE and carries the refusal text the server sent', async () => {
        vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'The last bot cannot be deleted.' }), { status: 409 }))));

        const failure = await deleteBot('bot-1')
            .catch((error: unknown) => error);

        expect(failure)
            .toBeInstanceOf(RequestFailedError);
        expect(failure instanceof RequestFailedError ? failure.serverMessage : undefined)
            .toBe('The last bot cannot be deleted.');
    });
});
