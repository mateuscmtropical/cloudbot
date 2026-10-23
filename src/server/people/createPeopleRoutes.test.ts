import { describe, expect, it, vi } from 'vitest';

import type { Person, PersonWithPassword } from '../../shared/peopleTypes.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';
import type { PeopleAdmin } from './PeopleAdmin.ts';
import { createPeopleRoutes } from './createPeopleRoutes.ts';

const MARIA: Person = {
    name: 'maria',
    role: 'member',
    state: 'active',
    instance: 'stopped',
    address: 'https://maria.example.com',
    createdAt: 1,
    lastSeenAt: null,
};

const INACTIVE_MARIA: Person = { ...MARIA, state: 'inactive' };
const CREATED_MARIA: PersonWithPassword = { person: MARIA, password: 'one-time-password' };

function createFakePeopleAdmin(): PeopleAdmin {
    return {
        list: vi.fn(() => Promise.resolve([MARIA])),
        add: vi.fn(() => Promise.resolve(CREATED_MARIA)),
        deactivate: vi.fn(() => Promise.resolve(INACTIVE_MARIA)),
        reactivate: vi.fn(() => Promise.resolve(MARIA)),
        resetPassword: vi.fn(() => Promise.resolve({ password: 'reset-password' })),
        remove: vi.fn(() => Promise.resolve()),
    };
}

function jsonRequest(body: unknown): RequestInit {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

describe('createPeopleRoutes', () => {
    it('lists and adds people with a one time password response', async () => {
        const peopleAdmin = createFakePeopleAdmin();
        const routes = createPeopleRoutes({ peopleAdmin });
        const listResponse = await routes.request('/api/people');
        const addResponse = await routes.request('/api/people', { method: 'POST', ...jsonRequest({ name: 'maria' }) });

        expect(listResponse.status)
            .toBe(200);
        expect(await listResponse.json())
            .toEqual([MARIA]);
        expect(addResponse.status)
            .toBe(201);
        expect(await addResponse.json())
            .toEqual(CREATED_MARIA);
        expect(peopleAdmin.add)
            .toHaveBeenCalledWith('maria');
    });

    it('validates names before calling the people admin', async () => {
        const peopleAdmin = createFakePeopleAdmin();
        const routes = createPeopleRoutes({ peopleAdmin });
        const invalidAdd = await routes.request('/api/people', { method: 'POST', ...jsonRequest({ name: 'Bad_Name' }) });
        const invalidAction = await routes.request('/api/people/Bad_Name/deactivate', { method: 'POST' });

        expect(invalidAdd.status)
            .toBe(400);
        expect(await invalidAdd.json())
            .toEqual({ error: 'Use 2 to 30 lowercase letters, digits or hyphens. Start with a letter and do not end with a hyphen.' });
        expect(invalidAction.status)
            .toBe(400);
        expect(peopleAdmin.add)
            .not.toHaveBeenCalled();
        expect(peopleAdmin.deactivate)
            .not.toHaveBeenCalled();
    });

    it('runs person actions and returns a generated reset password in its response', async () => {
        const peopleAdmin = createFakePeopleAdmin();
        const routes = createPeopleRoutes({ peopleAdmin });
        const deactivated = await routes.request('/api/people/maria/deactivate', { method: 'POST' });
        const reactivated = await routes.request('/api/people/maria/reactivate', { method: 'POST' });
        const reset = await routes.request('/api/people/maria/reset-password', { method: 'POST' });

        expect(await deactivated.json())
            .toEqual(INACTIVE_MARIA);
        expect(await reactivated.json())
            .toEqual(MARIA);
        expect(await reset.json())
            .toEqual({ password: 'reset-password' });
    });

    it('requires the person name before deleting', async () => {
        const peopleAdmin = createFakePeopleAdmin();
        const routes = createPeopleRoutes({ peopleAdmin });
        const refused = await routes.request('/api/people/maria', { method: 'DELETE' });

        expect(refused.status)
            .toBe(400);
        expect(peopleAdmin.remove)
            .not.toHaveBeenCalled();

        const removed = await routes.request('/api/people/maria', { method: 'DELETE', ...jsonRequest({ confirm: 'maria' }) });

        expect(removed.status)
            .toBe(204);
        expect(peopleAdmin.remove)
            .toHaveBeenCalledWith('maria');
    });

    it('maps PeopleAdminError to its status and error message', async () => {
        const peopleAdmin = createFakePeopleAdmin();

        vi.mocked(peopleAdmin.add)
            .mockRejectedValueOnce(new PeopleAdminError('That name already exists.', 409));

        const routes = createPeopleRoutes({ peopleAdmin });
        const response = await routes.request('/api/people', { method: 'POST', ...jsonRequest({ name: 'maria' }) });

        expect(response.status)
            .toBe(409);
        expect(await response.json())
            .toEqual({ error: 'That name already exists.' });
    });
});
