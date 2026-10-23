import { describe, expect, it } from 'vitest';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../shared/hubProtocol.ts';
import type { PeopleStore, PersonRecord, PersonUpdate } from './contract.ts';
import type { InstanceManager } from './contract.ts';
import { createHubApp } from './createHubApp.ts';

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

const NOOP_INSTANCES: InstanceManager = {
    status: () => Promise.resolve('stopped'),
    create: () => Promise.resolve(),
    start: () => Promise.resolve('running'),
    stop: () => Promise.resolve(),
    remove: () => Promise.resolve(),
};

function makeRecord(name: string): PersonRecord {
    return {
        name,
        role: name === 'owner' ? 'owner' : 'member',
        state: 'active',
        passwordHash: 'scrypt$aa$bb',
        mustChangePassword: true,
        instanceSecret: `${name}-secret`,
        createdAt: 1,
        lastSeenAt: null,
    };
}

describe('createHubApp', () => {
    it('answers the internal health check', async () => {
        const app = createHubApp({ people: new FakePeopleStore([]), instances: NOOP_INSTANCES, domain: 'example.com', secure: true });

        const response = await app.request('/internal/health');

        expect(response.status)
            .toBe(200);
        await expect(response.json())
            .resolves.toEqual({ status: 'ok' });
    });

    it('mounts the owner admin API under its internal path', async () => {
        const owner = makeRecord('owner');
        const people = new FakePeopleStore([owner]);
        const app = createHubApp({ people, instances: NOOP_INSTANCES, domain: 'example.com', secure: true });
        const headers = {
            [INSTANCE_NAME_HEADER]: 'owner',
            [INSTANCE_SECRET_HEADER]: owner.instanceSecret,
        };

        const response = await app.request('/internal/people', { headers });

        expect(response.status)
            .toBe(200);
    });
    it('allows TLS requests for the apex and known person hosts only', async () => {
        const people = new FakePeopleStore([makeRecord('owner'), makeRecord('maria')]);
        const app = createHubApp({ people, instances: NOOP_INSTANCES, domain: 'example.com', secure: true });

        expect((await app.request('/internal/tls-ask?domain=example.com')).status)
            .toBe(200);
        expect((await app.request('/internal/tls-ask?domain=maria.example.com')).status)
            .toBe(200);
        expect((await app.request('/internal/tls-ask?domain=unknown.example.com')).status)
            .toBe(404);
    });
});
