import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Person } from '../shared/peopleTypes.ts';
import { addPerson, deletePerson, listPeople, resetPersonPassword } from './peopleClient.ts';

const MARIA: Person = {
    name: 'maria',
    role: 'member',
    state: 'active',
    instance: 'stopped',
    address: 'https://maria.example.com',
    createdAt: 1,
    lastSeenAt: null,
};

function jsonResponse(body: unknown, status: number): Response {
    const serializedBody = JSON.stringify(body);

    return new Response(serializedBody, { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('peopleClient', () => {
    it('lists people from the owner API', async () => {
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(jsonResponse([MARIA], 200));

        vi.stubGlobal('fetch', fetchFunction);

        const people = await listPeople();

        expect(people)
            .toEqual([MARIA]);
        expect(fetchFunction)
            .toHaveBeenCalledWith('/api/people', { method: 'GET' });
    });

    it('requires a 200 response before the app treats the people route as available', async () => {
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }));

        vi.stubGlobal('fetch', fetchFunction);

        await expect(listPeople())
            .rejects.toMatchObject({ status: 204 });
    });

    it('adds a person and reads the one time password response', async () => {
        const createdPerson = { person: MARIA, password: 'one-time-password' };
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(jsonResponse(createdPerson, 201));

        vi.stubGlobal('fetch', fetchFunction);

        const created = await addPerson('maria');

        expect(created)
            .toEqual(createdPerson);
        expect(fetchFunction.mock.calls[0]?.[1])
            .toMatchObject({ method: 'POST', body: '{"name":"maria"}' });
    });

    it('resets a password using the encoded person name', async () => {
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(jsonResponse({ password: 'reset-password' }, 200));

        vi.stubGlobal('fetch', fetchFunction);

        const reset = await resetPersonPassword('maria');

        expect(reset)
            .toEqual({ password: 'reset-password' });
        expect(fetchFunction)
            .toHaveBeenCalledWith('/api/people/maria/reset-password', expect.objectContaining({ method: 'POST' }));
    });

    it('confirms the person name in a delete request', async () => {
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }));

        vi.stubGlobal('fetch', fetchFunction);

        await deletePerson('maria');

        expect(fetchFunction.mock.calls[0]?.[1])
            .toMatchObject({ method: 'DELETE', body: '{"confirm":"maria"}' });
    });

    it('preserves the server message for failed people requests', async () => {
        const fetchFunction = vi.fn<typeof fetch>()
            .mockResolvedValue(jsonResponse({ error: 'That name is reserved.' }, 400));

        vi.stubGlobal('fetch', fetchFunction);

        await expect(addPerson('admin'))
            .rejects.toMatchObject({ status: 400, serverMessage: 'That name is reserved.' });
    });
});
