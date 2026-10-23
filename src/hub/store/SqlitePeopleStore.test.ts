import { describe, expect, it } from 'vitest';

import type { PersonRecord } from '../contract.ts';
import { openHubDatabase } from './openHubDatabase.ts';
import { SqlitePeopleStore } from './SqlitePeopleStore.ts';

function makeRecord(name: string, createdAt: number): PersonRecord {
    return {
        name,
        role: 'member',
        state: 'active',
        passwordHash: 'scrypt$aa$bb',
        mustChangePassword: true,
        instanceSecret: 'secret',
        createdAt,
        lastSeenAt: null,
    };
}

function makeStore(): SqlitePeopleStore {
    const database = openHubDatabase(':memory:');

    return new SqlitePeopleStore(database);
}

describe('SqlitePeopleStore', () => {
    it('adds a person and finds them again', () => {
        const store = makeStore();

        store.add(makeRecord('maria', 1));

        expect(store.find('maria'))
            .toEqual(makeRecord('maria', 1));
        expect(store.find('nobody'))
            .toBeUndefined();
    });

    it('lists people in the order they were added', () => {
        const store = makeStore();

        store.add(makeRecord('joao', 2));
        store.add(makeRecord('maria', 1));

        expect(store.list()
            .map(record => record.name))
            .toEqual(['maria', 'joao']);
    });

    it('refuses a second person with the same name', () => {
        const store = makeStore();

        store.add(makeRecord('maria', 1));

        expect(() => {
            store.add(makeRecord('maria', 2));
        })
            .toThrow();
    });

    it('updates only the fields it is given', () => {
        const store = makeStore();

        store.add(makeRecord('maria', 1));
        store.update('maria', { state: 'inactive', lastSeenAt: 99 });

        expect(store.find('maria'))
            .toEqual({ ...makeRecord('maria', 1), state: 'inactive', lastSeenAt: 99 });
    });

    it('removes a person', () => {
        const store = makeStore();

        store.add(makeRecord('maria', 1));
        store.remove('maria');

        expect(store.list())
            .toEqual([]);
    });
});
