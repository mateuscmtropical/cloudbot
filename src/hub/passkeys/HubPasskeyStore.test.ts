import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersonRecord } from '../contract.ts';
import { openHubDatabase } from '../store/openHubDatabase.ts';
import { SqlitePeopleStore } from '../store/SqlitePeopleStore.ts';
import { createHubPasskeyTables, HubPasskeyLimitError, SqliteHubPasskeyStore } from './HubPasskeyStore.ts';

function makePerson(name: string): PersonRecord {
    return {
        name,
        role: 'member',
        state: 'active',
        passwordHash: 'hash',
        mustChangePassword: false,
        instanceSecret: 'secret',
        createdAt: 1,
        lastSeenAt: null,
    };
}

describe('SqliteHubPasskeyStore', () => {
    let database: ReturnType<typeof openHubDatabase>;
    let people: SqlitePeopleStore;
    let store: SqliteHubPasskeyStore;

    beforeEach(() => {
        database = openHubDatabase(':memory:');
        people = new SqlitePeopleStore(database);
        createHubPasskeyTables(database);
        store = new SqliteHubPasskeyStore(database, { now: () => 100 });
    });

    afterEach(() => {
        database.close();
    });
    it('stores credentials per person without exposing them in the summary shape', () => {
        people.add(makePerson('maria'));
        const added = store.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 2,
            transports: ['internal'],
            label: 'Phone',
        });

        expect(added)
            .toEqual({
                personName: 'maria',
                credentialId: 'credential-1',
                publicKey: 'AQID',
                counter: 2,
                transports: ['internal'],
                label: 'Phone',
                createdAt: 100,
            });
        expect(store.list('maria'))
            .toEqual([added]);
        expect(store.get('joao', 'credential-1'))
            .toBeUndefined();
    });

    it('updates a signature counter and removes only the matching person credential', () => {
        people.add(makePerson('maria'));
        people.add(makePerson('joao'));
        const mariaPasskey = store.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });

        store.add({
            personName: 'joao',
            credentialId: 'credential-1',
            publicKey: 'BAUG',
            counter: 0,
            transports: [],
            label: 'Laptop',
        });

        store.updateCounter('maria', mariaPasskey.credentialId, 7);

        expect(store.get('maria', 'credential-1')?.counter)
            .toBe(7);
        expect(store.remove('maria', 'credential-1'))
            .toBe(true);
        expect(store.get('joao', 'credential-1'))
            .toBeDefined();
    });

    it('removes a person’s passkeys when the person is deleted', () => {
        people.add(makePerson('maria'));
        store.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });

        people.remove('maria');

        expect(store.list('maria'))
            .toEqual([]);
    });

    it('refuses an eleventh passkey for one person', () => {
        people.add(makePerson('maria'));
        const passkeys = Array.from({ length: 10 }, (_unused, index) => ({
            personName: 'maria',
            credentialId: 'credential-' + String(index),
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Key',
        }));

        passkeys.forEach(passkey => store.add(passkey));

        expect(() => {
            store.add({
                personName: 'maria',
                credentialId: 'credential-11',
                publicKey: 'AQID',
                counter: 0,
                transports: [],
                label: 'Key',
            });
        })
            .toThrow(HubPasskeyLimitError);
    });
});
