import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../shared/hubProtocol.ts';
import type { ActivityTracker, PeopleStore, PersonRecord, PersonUpdate } from './contract.ts';
import type { InstanceManager } from './contract.ts';
import { createHubApp } from './createHubApp.ts';
import type { OwnerSetupOptions } from './auth/createFrontDoorRoutes.ts';
import { createLoginSessionTables, SqliteLoginSessions } from './auth/LoginSessions.ts';
import { openHubDatabase } from './store/openHubDatabase.ts';
import { createHubPasskeyTables, SqliteHubPasskeyStore } from './passkeys/HubPasskeyStore.ts';
import { HubPasskeyService } from './passkeys/HubPasskeyService.ts';

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

const NOOP_ACTIVITY: ActivityTracker = {
    touch: () => undefined,
    opened: () => undefined,
    closed: () => undefined,
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

function createTestApp(people: PeopleStore, instances: InstanceManager = NOOP_INSTANCES, domain = 'example.com', ownerSetup?: OwnerSetupOptions): { app: Hono; database: ReturnType<typeof openHubDatabase> } {
    const database = openHubDatabase(':memory:');

    createLoginSessionTables(database);
    createHubPasskeyTables(database);
    const sessions = new SqliteLoginSessions(database);
    const passkeyStore = new SqliteHubPasskeyStore(database);
    const passkeys = new HubPasskeyService({ store: passkeyStore, domain });
    const app = createHubApp({
        people,
        instances,
        sessions,
        passkeys,
        passkeyStore,
        domain,
        secure: domain !== 'localhost',
        activity: NOOP_ACTIVITY,
        ...(ownerSetup === undefined ? {} : { ownerSetup }),
    });

    return { app, database };
}

describe('createHubApp', () => {
    it('answers the internal health check only on an internal host', async () => {
        const people = new FakePeopleStore([]);
        const { app, database } = createTestApp(people);

        const response = await app.request('http://127.0.0.1:3001/internal/health', { headers: { host: '127.0.0.1:3001' } });

        expect(response.status)
            .toBe(200);
        await expect(response.json())
            .resolves.toEqual({ status: 'ok' });
        database.close();
    });

    it('hides internal routes on public person hosts and serves them to the hub container', async () => {
        const owner = makeRecord('owner');
        const people = new FakePeopleStore([owner]);
        const { app, database } = createTestApp(people);
        const headers = {
            [INSTANCE_NAME_HEADER]: 'owner',
            [INSTANCE_SECRET_HEADER]: owner.instanceSecret,
        };

        const publicResponse = await app.request('http://maria.localhost:3200/internal/people', { headers: { ...headers, host: 'maria.localhost:3200' } });
        const internalResponse = await app.request('http://hub:3001/internal/people', { headers: { ...headers, host: 'hub:3001' } });
        const unknownInternalResponse = await app.request('http://hub:3001/internal/not-a-route', { headers: { host: 'hub:3001' } });
        const publicBody = await publicResponse.text();

        expect(publicResponse.status)
            .toBe(404);
        expect(JSON.parse(publicBody))
            .toEqual({ error: 'Not found.' });
        expect(internalResponse.status)
            .toBe(200);
        expect(publicBody)
            .toBe(await unknownInternalResponse.text());
        database.close();
    });

    it('allows TLS requests for the apex and known person hosts only', async () => {
        const people = new FakePeopleStore([makeRecord('owner'), makeRecord('maria')]);
        const { app, database } = createTestApp(people);
        const headers = { host: 'hub:3001' };

        expect((await app.request('http://hub:3001/internal/tls-ask?domain=example.com', { headers })).status)
            .toBe(200);
        expect((await app.request('http://hub:3001/internal/tls-ask?domain=maria.example.com', { headers })).status)
            .toBe(200);
        expect((await app.request('http://hub:3001/internal/tls-ask?domain=unknown.example.com', { headers })).status)
            .toBe(404);
        database.close();
    });

    it('allows the TLS request of the owner address only while the owner does not exist', async () => {
        const ownerSetup: OwnerSetupOptions = { ownerName: 'boss', createOwner: () => Promise.resolve() };
        const emptyPeople = new FakePeopleStore([]);
        const emptyHub = createTestApp(emptyPeople, NOOP_INSTANCES, 'example.com', ownerSetup);
        const headers = { host: 'hub:3001' };

        expect((await emptyHub.app.request('http://hub:3001/internal/tls-ask?domain=boss.example.com', { headers })).status)
            .toBe(200);
        expect((await emptyHub.app.request('http://hub:3001/internal/tls-ask?domain=other.example.com', { headers })).status)
            .toBe(404);
        emptyHub.database.close();

        const ownedPeople = new FakePeopleStore([makeRecord('owner')]);
        const ownedHub = createTestApp(ownedPeople, NOOP_INSTANCES, 'example.com', ownerSetup);

        expect((await ownedHub.app.request('http://hub:3001/internal/tls-ask?domain=boss.example.com', { headers })).status)
            .toBe(404);
        ownedHub.database.close();
    });
});
