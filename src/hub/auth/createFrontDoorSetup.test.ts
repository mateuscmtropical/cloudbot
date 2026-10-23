import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';

import type { ActivityTracker, InstanceManager, PersonRecord, PersonUpdate, StartResult } from '../contract.ts';
import type { InstanceStatus } from '../../shared/peopleTypes.ts';
import { createFrontDoorRoutes } from './createFrontDoorRoutes.ts';
import type { FrontDoorRoutesOptions } from './createFrontDoorRoutes.ts';
import { createLoginSessionTables, SqliteLoginSessions } from './LoginSessions.ts';

interface SetupHarness {
    app: Hono;
    database: DatabaseSync;
    created: string[];
    failNextCreate: () => void;
}

const OWNER_NAME = 'boss';
const GOOD_PASSWORD = 'a long enough password';
const FORM_HEADERS = {
    'content-type': 'application/x-www-form-urlencoded',
    'origin': `https://${OWNER_NAME}.example.test`,
};

class FakePeople {
    private readonly records = new Map<string, PersonRecord>();

    find(name: string): PersonRecord | undefined {
        return this.records.get(name);
    }

    list(): PersonRecord[] {
        return Array.from(this.records.values());
    }

    add(record: PersonRecord): void {
        this.records.set(record.name, record);
    }

    update(name: string, update: PersonUpdate): void {
        const current = this.records.get(name);

        if (current !== undefined) {
            this.records.set(name, { ...current, ...update });
        }
    }

    remove(name: string): void {
        this.records.delete(name);
    }
}

class FakeInstances implements InstanceManager {
    status(): Promise<InstanceStatus> {
        return Promise.resolve('running');
    }

    create(): Promise<void> {
        return Promise.resolve();
    }

    start(): Promise<StartResult> {
        return Promise.resolve('running');
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    remove(): Promise<void> {
        return Promise.resolve();
    }
}

class FakeActivity implements ActivityTracker {
    touch(): void {}

    opened(): void {}

    closed(): void {}
}

function createHarness(): SetupHarness {
    const database = new DatabaseSync(':memory:');

    createLoginSessionTables(database);
    const sessions = new SqliteLoginSessions(database);
    const people = new FakePeople();
    const created: string[] = [];
    let shouldFail = false;
    const createOwner = (passwordHash: string): Promise<void> => {
        if (shouldFail) {
            shouldFail = false;

            return Promise.reject(new Error('docker is down'));
        }

        created.push(passwordHash);
        people.add({
            name: OWNER_NAME, role: 'owner', state: 'active', passwordHash, mustChangePassword: false,
            instanceSecret: 'secret', createdAt: 0, lastSeenAt: null,
        });

        return Promise.resolve();
    };
    const routeOptions: FrontDoorRoutesOptions = {
        people,
        instances: new FakeInstances(),
        sessions,
        domain: 'example.test',
        secure: true,
        activity: new FakeActivity(),
        ownerSetup: { ownerName: OWNER_NAME, createOwner },
    };
    const app = createFrontDoorRoutes(routeOptions);
    const failNextCreate = (): void => {
        shouldFail = true;
    };

    return { app, database, created, failNextCreate };
}

function postSetup(app: Hono, password: string, confirmation: string): Promise<Response> {
    const body = new URLSearchParams({ password, confirmation });

    return Promise.resolve(app.request(`https://${OWNER_NAME}.example.test/__hub/setup`, { method: 'POST', headers: FORM_HEADERS, body }));
}

describe('owner setup on a new hub', () => {
    let harness: SetupHarness;

    beforeEach(() => {
        harness = createHarness();
    });

    afterEach(() => {
        harness.database.close();
    });

    it('sends the apex address to the owner address', async () => {
        const response = await harness.app.request('https://example.test/');

        expect(response.status)
            .toBe(303);
        expect(response.headers.get('location'))
            .toBe(`https://${OWNER_NAME}.example.test/`);
    });

    it('shows the setup page at the owner address and hides every other address', async () => {
        const ownerResponse = await harness.app.request(`https://${OWNER_NAME}.example.test/`);
        const ownerText = await ownerResponse.text();
        const otherResponse = await harness.app.request('https://maria.example.test/');

        expect(ownerResponse.status)
            .toBe(200);
        expect(ownerText)
            .toContain('Set up CloudBot');
        expect(otherResponse.status)
            .toBe(404);
    });

    it('rejects a short password and a wrong confirmation', async () => {
        const shortResponse = await postSetup(harness.app, 'short', 'short');
        const mismatchResponse = await postSetup(harness.app, GOOD_PASSWORD, `${GOOD_PASSWORD}!`);

        expect(shortResponse.status)
            .toBe(401);
        expect(mismatchResponse.status)
            .toBe(401);
        expect(harness.created)
            .toEqual([]);
    });

    it('creates the owner, signs in and closes the setup', async () => {
        const response = await postSetup(harness.app, GOOD_PASSWORD, GOOD_PASSWORD);
        const secondResponse = await postSetup(harness.app, GOOD_PASSWORD, GOOD_PASSWORD);
        const pageResponse = await harness.app.request(`https://${OWNER_NAME}.example.test/`);
        const pageText = await pageResponse.text();

        expect(response.status)
            .toBe(303);
        expect(response.headers.get('set-cookie'))
            .toContain('cloudbot_hub_session=');
        expect(harness.created)
            .toHaveLength(1);
        expect(harness.created[0])
            .toMatch(/^scrypt\$/);
        expect(secondResponse.status)
            .not
            .toBe(303);
        expect(harness.created)
            .toHaveLength(1);
        expect(pageText)
            .not
            .toContain('Set up CloudBot');
    });

    it('lets the person try again when the owner could not be created', async () => {
        harness.failNextCreate();

        const failedResponse = await postSetup(harness.app, GOOD_PASSWORD, GOOD_PASSWORD);
        const retryResponse = await postSetup(harness.app, GOOD_PASSWORD, GOOD_PASSWORD);

        expect(failedResponse.status)
            .toBe(500);
        expect(retryResponse.status)
            .toBe(303);
    });
});
