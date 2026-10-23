import { describe, expect, it } from 'vitest';

import type { InstanceManager, PeopleStore, PersonRecord, PersonUpdate, StartResult } from './contract.ts';
import { createOwner, resetPassword } from './main.ts';

class FakePeopleStore implements PeopleStore {
    private readonly records: Map<string, PersonRecord>;

    constructor(records: PersonRecord[] = []) {
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

class FakeInstanceManager implements InstanceManager {
    readonly created: PersonRecord[] = [];

    status(): Promise<'missing'> {
        return Promise.resolve('missing');
    }

    create(record: PersonRecord): Promise<void> {
        this.created.push(record);

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

describe('createOwner', () => {
    it('creates the owner with the chosen password and no forced change', async () => {
        const people = new FakePeopleStore();
        const instances = new FakeInstanceManager();

        await createOwner({ people, instances, ownerName: 'owner', passwordHash: 'scrypt$aa$bb' });

        expect(instances.created)
            .toHaveLength(1);
        expect(people.find('owner'))
            .toMatchObject({ role: 'owner', state: 'active', passwordHash: 'scrypt$aa$bb', mustChangePassword: false });
    });

    it('refuses to create a second owner', async () => {
        const owner: PersonRecord = {
            name: 'owner', role: 'owner', state: 'active', passwordHash: 'scrypt$aa$bb', mustChangePassword: false,
            instanceSecret: 'secret', createdAt: 1, lastSeenAt: null,
        };
        const people = new FakePeopleStore([owner]);
        const instances = new FakeInstanceManager();

        await expect(createOwner({ people, instances, ownerName: 'other', passwordHash: 'x' }))
            .rejects
            .toThrow('already has an owner');
        expect(instances.created)
            .toEqual([]);
    });
});
describe('resetPassword', () => {
    it('stores a password hash and requires a change', async () => {
        const person: PersonRecord = {
            name: 'maria', role: 'member', state: 'active', passwordHash: 'old-hash', mustChangePassword: false,
            instanceSecret: 'secret', createdAt: 1, lastSeenAt: null,
        };
        const people = new FakePeopleStore([person]);

        const password = await resetPassword(people, 'maria');

        expect(password)
            .toMatch(/^[a-zA-Z2-9]{16}$/);
        const updatedPerson = people.find('maria');

        expect(updatedPerson?.mustChangePassword)
            .toBe(true);
        expect(updatedPerson?.passwordHash.startsWith('scrypt$'))
            .toBe(true);
    });
});
