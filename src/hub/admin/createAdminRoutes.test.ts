import { afterEach, describe, expect, it, vi } from 'vitest';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { InstanceManager, PeopleStore, PersonRecord, PersonUpdate, StartResult } from '../contract.ts';
import { createAdminRoutes } from './createAdminRoutes.ts';

interface TestRecord {
    [key: string]: unknown;
}

class FakePeopleStore implements PeopleStore {
    private readonly records: Map<string, PersonRecord>;

    constructor(records: PersonRecord[]) {
        this.records = new Map(records.map(record => [record.name, record]));
    }

    list(): PersonRecord[] {
        return Array.from(this.records.values());
    }

    find(name: string): PersonRecord | undefined {
        return this.records.get(name);
    }

    add(record: PersonRecord): void {
        if (this.records.has(record.name)) {
            throw new Error('Duplicate person.');
        }

        this.records.set(record.name, record);
    }

    update(name: string, update: PersonUpdate): void {
        const record = this.records.get(name);

        if (record !== undefined) {
            this.records.set(name, { ...record, ...update });
        }
    }

    remove(name: string): void {
        this.records.delete(name);
    }
}

class FakeInstanceManager implements InstanceManager {
    readonly created: PersonRecord[] = [];
    readonly calls: string[] = [];
    readonly statuses: Map<string, 'missing' | 'stopped' | 'starting' | 'running'> = new Map();

    status(name: string): Promise<'missing' | 'stopped' | 'starting' | 'running'> {
        this.calls.push(`status:${name}`);

        return Promise.resolve(this.statuses.get(name) ?? 'missing');
    }

    create(record: PersonRecord): Promise<void> {
        this.calls.push(`create:${record.name}`);
        this.created.push(record);
        this.statuses.set(record.name, 'stopped');

        return Promise.resolve();
    }

    start(): Promise<StartResult> {
        return Promise.resolve('running');
    }

    stop(name: string): Promise<void> {
        this.calls.push(`stop:${name}`);
        this.statuses.set(name, 'stopped');

        return Promise.resolve();
    }

    remove(name: string): Promise<void> {
        this.calls.push(`remove:${name}`);
        this.statuses.delete(name);

        return Promise.resolve();
    }
}

const OWNER: PersonRecord = {
    name: 'owner', role: 'owner', state: 'active', passwordHash: 'scrypt$aa$bb', mustChangePassword: true,
    instanceSecret: 'owner-instance-secret', createdAt: 1, lastSeenAt: null,
};
const MEMBER: PersonRecord = {
    name: 'maria', role: 'member', state: 'active', passwordHash: 'scrypt$cc$dd', mustChangePassword: true,
    instanceSecret: 'maria-instance-secret', createdAt: 2, lastSeenAt: 10,
};
const OWNER_HEADERS: Record<string, string> = {
    [INSTANCE_NAME_HEADER]: OWNER.name,
    [INSTANCE_SECRET_HEADER]: OWNER.instanceSecret,
};

function makeRoutes(records: PersonRecord[] = [OWNER, MEMBER]): { app: ReturnType<typeof createAdminRoutes>; people: FakePeopleStore; instances: FakeInstanceManager } {
    const people = new FakePeopleStore(records);
    const instances = new FakeInstanceManager();
    const app = createAdminRoutes({ people, instances, domain: 'example.com', secure: true });

    return { app, people, instances };
}

async function readResponseBody(response: Response): Promise<unknown> {
    const responseText = await response.text();
    const body: unknown = JSON.parse(responseText) as unknown;

    return body;
}

function readRecord(value: unknown): TestRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Expected an object response.');
    }

    return value as TestRecord;
}

function readText(record: TestRecord, key: string): string {
    const value = record[key];

    if (typeof value !== 'string') {
        throw new Error(`Expected ${key} to be text.`);
    }

    return value;
}

describe('createAdminRoutes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('requires owner authentication on every admin route', async () => {
        const { app } = makeRoutes();
        const requests = [
            app.request('/internal/people'),
            app.request('/internal/people', { method: 'POST', body: JSON.stringify({ name: 'joao' }) }),
            app.request('/internal/people/maria/deactivate', { method: 'POST' }),
            app.request('/internal/people/maria/reactivate', { method: 'POST' }),
            app.request('/internal/people/maria/reset-password', { method: 'POST' }),
            app.request('/internal/people/maria?confirm=maria', { method: 'DELETE' }),
        ];
        const requestPromises = requests.map(request => Promise.resolve(request));
        const responses = await Promise.all(requestPromises);
        const statuses = responses.map(response => response.status);

        expect(statuses)
            .toEqual([401, 401, 401, 401, 401, 401]);
    });

    it('lists people with instance status and secure addresses', async () => {
        const { app, instances } = makeRoutes();

        instances.statuses.set('maria', 'running');

        const response = await app.request('/internal/people', { headers: OWNER_HEADERS });
        const answer = await readResponseBody(response);

        expect(response.status)
            .toBe(200);
        expect(answer)
            .toEqual([
                { name: 'owner', role: 'owner', state: 'active', instance: 'missing', address: 'https://owner.example.com', createdAt: 1, lastSeenAt: null },
                { name: 'maria', role: 'member', state: 'active', instance: 'running', address: 'https://maria.example.com', createdAt: 2, lastSeenAt: 10 },
            ]);
    });

    it('validates names and creates a person with a one-time password that is never logged', async () => {
        const { app, people, instances } = makeRoutes();
        const logSpy = vi.spyOn(console, 'log');
        const errorSpy = vi.spyOn(console, 'error');
        const invalidResponse = await app.request('/internal/people', {
            method: 'POST',
            headers: { ...OWNER_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Bad Name' }),
        });
        const takenResponse = await app.request('/internal/people', {
            method: 'POST',
            headers: { ...OWNER_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'maria' }),
        });
        const response = await app.request('/internal/people', {
            method: 'POST',
            headers: { ...OWNER_HEADERS, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'joao' }),
        });
        const answer = await readResponseBody(response);
        const answerRecord = readRecord(answer);
        const personRecord = readRecord(answerRecord.person);
        const password = readText(answerRecord, 'password');
        const createdRecord = people.find('joao');

        expect(invalidResponse.status)
            .toBe(400);
        expect(takenResponse.status)
            .toBe(409);
        expect(response.status)
            .toBe(201);
        expect(personRecord.name)
            .toBe('joao');
        expect(personRecord.role)
            .toBe('member');
        expect(personRecord.state)
            .toBe('active');
        expect(personRecord.instance)
            .toBe('stopped');
        expect(personRecord.address)
            .toBe('https://joao.example.com');
        expect(password)
            .toMatch(/^[a-zA-Z2-9]{16}$/);
        expect(createdRecord?.role)
            .toBe('member');
        expect(createdRecord?.mustChangePassword)
            .toBe(true);
        expect(createdRecord?.instanceSecret)
            .toMatch(/^[a-zA-Z0-9_-]{43}$/);
        expect(instances.created)
            .toHaveLength(1);
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('deactivates and reactivates people without starting their instances', async () => {
        const { app, people, instances } = makeRoutes();

        instances.statuses.set('maria', 'running');

        const deactivateResponse = await app.request('/internal/people/maria/deactivate', { method: 'POST', headers: OWNER_HEADERS });
        const deactivated = await readResponseBody(deactivateResponse);
        const reactivateResponse = await app.request('/internal/people/maria/reactivate', { method: 'POST', headers: OWNER_HEADERS });
        const reactivated = await readResponseBody(reactivateResponse);

        expect(deactivated)
            .toMatchObject({ name: 'maria', state: 'inactive', instance: 'stopped' });
        expect(reactivated)
            .toMatchObject({ name: 'maria', state: 'active', instance: 'stopped' });
        expect(people.find('maria')?.state)
            .toBe('active');
        expect(instances.calls.filter(call => call.startsWith('start:')))
            .toEqual([]);
    });

    it('resets a password and requires a change without logging the password', async () => {
        const { app, people } = makeRoutes();
        const logSpy = vi.spyOn(console, 'log');
        const errorSpy = vi.spyOn(console, 'error');
        const response = await app.request('/internal/people/maria/reset-password', { method: 'POST', headers: OWNER_HEADERS });
        const answer = await readResponseBody(response);
        const answerRecord = readRecord(answer);
        const password = readText(answerRecord, 'password');
        const updatedRecord = people.find('maria');

        expect(response.status)
            .toBe(200);
        expect(password)
            .toMatch(/^[a-zA-Z2-9]{16}$/);
        expect(updatedRecord?.mustChangePassword)
            .toBe(true);
        expect(updatedRecord?.passwordHash.startsWith('scrypt$'))
            .toBe(true);
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it('requires matching confirmation and prevents owner removal', async () => {
        const { app, people, instances } = makeRoutes();
        const unconfirmed = await app.request('/internal/people/maria', { method: 'DELETE', headers: OWNER_HEADERS });
        const ownerRemoval = await app.request('/internal/people/owner?confirm=owner', { method: 'DELETE', headers: OWNER_HEADERS });
        const removal = await app.request('/internal/people/maria?confirm=maria', { method: 'DELETE', headers: OWNER_HEADERS });

        expect(unconfirmed.status)
            .toBe(400);
        expect(ownerRemoval.status)
            .toBe(409);
        expect(removal.status)
            .toBe(204);
        expect(people.find('maria'))
            .toBeUndefined();
        expect(instances.calls)
            .toContain('remove:maria');
    });

    it('returns JSON errors for unknown people and invalid request bodies', async () => {
        const { app } = makeRoutes();
        const unknownResponse = await app.request('/internal/people/nobody/reactivate', { method: 'POST', headers: OWNER_HEADERS });
        const malformedResponse = await app.request('/internal/people', {
            method: 'POST',
            headers: { ...OWNER_HEADERS, 'content-type': 'application/json' },
            body: '{',
        });
        const unknownAnswer = await readResponseBody(unknownResponse);
        const malformedAnswer = await readResponseBody(malformedResponse);

        expect(unknownResponse.status)
            .toBe(404);
        expect(unknownAnswer)
            .toEqual({ error: 'Person not found.' });
        expect(malformedResponse.status)
            .toBe(400);
        expect(malformedAnswer)
            .toEqual({ error: 'A person name is required.' });
    });
});
