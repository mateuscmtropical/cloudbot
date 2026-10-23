import { describe, expect, it, vi } from 'vitest';

import type { Person } from '../../shared/peopleTypes.ts';
import { HubClient } from './HubClient.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';

const CONFIG = { hubUrl: 'http://hub:3001', secret: 'secret-1', personName: 'owner', role: 'owner' } as const;

const MARIA: Person = {
    name: 'maria',
    role: 'member',
    state: 'active',
    instance: 'stopped',
    address: 'https://maria.example.com',
    createdAt: 1,
    lastSeenAt: null,
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('HubClient', () => {
    it('lists people and sends the instance name and secret', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(jsonResponse([MARIA])));
        const client = new HubClient(CONFIG, fetchFunction);

        const people = await client.list();

        expect(people)
            .toEqual([MARIA]);
        expect(fetchFunction)
            .toHaveBeenCalledWith('http://hub:3001/internal/people', {
                method: 'GET',
                headers: { 'x-cloudbot-instance': 'owner', 'x-cloudbot-secret': 'secret-1' },
            });
    });

    it('adds a person and returns the one time password', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(jsonResponse({ person: MARIA, password: 'pw-123' }, 201)));
        const client = new HubClient(CONFIG, fetchFunction);

        const created = await client.add('maria');

        expect(created)
            .toEqual({ person: MARIA, password: 'pw-123' });
        expect(fetchFunction)
            .toHaveBeenCalledWith('http://hub:3001/internal/people', expect.objectContaining({ method: 'POST', body: '{"name":"maria"}' }));
    });

    it('calls the action paths for one person', async () => {
        const urls: string[] = [];
        const fetchFunction = vi.fn((input: string | URL | Request) => {
            // HubClient always passes a string.
            urls.push(input as string);

            return Promise.resolve(jsonResponse({ ...MARIA, state: 'inactive' }));
        });
        const client = new HubClient(CONFIG, fetchFunction);

        await client.deactivate('maria');
        await client.reactivate('maria');

        expect(urls)
            .toEqual(['http://hub:3001/internal/people/maria/deactivate', 'http://hub:3001/internal/people/maria/reactivate']);
    });

    it('resets a password', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(jsonResponse({ password: 'new-pw' })));
        const client = new HubClient(CONFIG, fetchFunction);

        const result = await client.resetPassword('maria');

        expect(result)
            .toEqual({ password: 'new-pw' });
    });

    it('removes a person with the confirmation in the query', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
        const client = new HubClient(CONFIG, fetchFunction);

        await client.remove('maria');

        expect(fetchFunction)
            .toHaveBeenCalledWith('http://hub:3001/internal/people/maria?confirm=maria', expect.objectContaining({ method: 'DELETE' }));
    });

    it('turns a refusal into an error with the hub message', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(jsonResponse({ error: 'That name is taken.' }, 409)));
        const client = new HubClient(CONFIG, fetchFunction);

        const failure = await client.add('maria')
            .catch((error: unknown) => error);

        expect(failure)
            .toBeInstanceOf(PeopleAdminError);
        expect(failure)
            .toMatchObject({ message: 'That name is taken.', status: 409 });
    });

    it('says so when the hub cannot be reached', async () => {
        const fetchFunction = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
        const client = new HubClient(CONFIG, fetchFunction);

        const failure = await client.list()
            .catch((error: unknown) => error);

        expect(failure)
            .toMatchObject({ message: 'Could not reach the hub.', status: 502 });
    });

    it('refuses an answer with the wrong shape', async () => {
        const fetchFunction = vi.fn(() => Promise.resolve(jsonResponse([{ name: 'maria' }])));
        const client = new HubClient(CONFIG, fetchFunction);

        const failure = await client.list()
            .catch((error: unknown) => error);

        expect(failure)
            .toMatchObject({ message: 'The hub answered with something unexpected.' });
    });
});
