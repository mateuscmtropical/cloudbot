import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

const MAX_HUB_PASSKEYS = 10;

interface HubPasskeyRecord {
    personName: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    label: string;
    createdAt: number;
}

interface NewHubPasskey {
    personName: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
    label: string;
}

interface HubPasskeyStore {
    list: (personName: string) => HubPasskeyRecord[];
    get: (personName: string, credentialId: string) => HubPasskeyRecord | undefined;
    add: (passkey: NewHubPasskey) => HubPasskeyRecord;
    updateCounter: (personName: string, credentialId: string, counter: number) => void;
    remove: (personName: string, credentialId: string) => boolean;
}

interface HubPasskeyStoreOptions {
    now?: (() => number) | undefined;
}

type Row = Record<string, SQLOutputValue>;

const CREATE_HUB_PASSKEYS_TABLE = [
    'CREATE TABLE IF NOT EXISTS hub_passkeys (',
    '    person_name TEXT NOT NULL REFERENCES people(name) ON DELETE CASCADE,',
    '    credential_id TEXT NOT NULL,',
    '    public_key TEXT NOT NULL,',
    '    signature_counter INTEGER NOT NULL,',
    '    transports TEXT NOT NULL,',
    '    label TEXT NOT NULL,',
    '    created_at INTEGER NOT NULL,',
    '    PRIMARY KEY (person_name, credential_id)',
    ')',
].join('\n');

function createHubPasskeyTables(database: DatabaseSync): void {
    database.exec(CREATE_HUB_PASSKEYS_TABLE);
}

function readText(row: Row, column: string): string {
    const value = row[column];

    return typeof value === 'string' ? value : '';
}

function readNumber(row: Row, column: string): number {
    const value = row[column];

    return typeof value === 'number' ? value : 0;
}

function readTransports(value: string): string[] {
    try {
        const parsed: unknown = JSON.parse(value);

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter((transport): transport is string => typeof transport === 'string');
    } catch {
        return [];
    }
}

function toRecord(row: Row): HubPasskeyRecord {
    const transports = readText(row, 'transports');

    return {
        personName: readText(row, 'person_name'),
        credentialId: readText(row, 'credential_id'),
        publicKey: readText(row, 'public_key'),
        counter: readNumber(row, 'signature_counter'),
        transports: readTransports(transports),
        label: readText(row, 'label'),
        createdAt: readNumber(row, 'created_at'),
    };
}

class HubPasskeyLimitError extends Error {}

class SqliteHubPasskeyStore implements HubPasskeyStore {
    private readonly database: DatabaseSync;
    private readonly now: () => number;

    constructor(database: DatabaseSync, options: HubPasskeyStoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    list(personName: string): HubPasskeyRecord[] {
        const statement = this.database.prepare('SELECT * FROM hub_passkeys WHERE person_name = ? ORDER BY created_at, credential_id');
        const rows = statement.all(personName);

        return rows.map(toRecord);
    }

    get(personName: string, credentialId: string): HubPasskeyRecord | undefined {
        const statement = this.database.prepare('SELECT * FROM hub_passkeys WHERE person_name = ? AND credential_id = ?');
        const row = statement.get(personName, credentialId);

        return row === undefined ? undefined : toRecord(row);
    }

    add(passkey: NewHubPasskey): HubPasskeyRecord {
        this.database.exec('BEGIN IMMEDIATE');

        try {
            const countStatement = this.database.prepare('SELECT COUNT(*) AS count FROM hub_passkeys WHERE person_name = ?');
            const countRow = countStatement.get(passkey.personName);
            const count = countRow === undefined ? 0 : readNumber(countRow, 'count');

            if (count >= MAX_HUB_PASSKEYS) {
                throw new HubPasskeyLimitError('There are already ' + String(MAX_HUB_PASSKEYS) + ' passkeys. Remove one first.');
            }

            const statement = this.database.prepare('INSERT INTO hub_passkeys (person_name, credential_id, public_key, signature_counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            const serializedTransports = JSON.stringify(passkey.transports);
            const createdAt = this.now();

            statement.run(passkey.personName, passkey.credentialId, passkey.publicKey, passkey.counter, serializedTransports, passkey.label, createdAt);
            this.database.exec('COMMIT');

            return { ...passkey, createdAt };
        } catch (error: unknown) {
            this.database.exec('ROLLBACK');

            throw error;
        }
    }

    updateCounter(personName: string, credentialId: string, counter: number): void {
        const statement = this.database.prepare('UPDATE hub_passkeys SET signature_counter = ? WHERE person_name = ? AND credential_id = ?');

        statement.run(counter, personName, credentialId);
    }

    remove(personName: string, credentialId: string): boolean {
        const statement = this.database.prepare('DELETE FROM hub_passkeys WHERE person_name = ? AND credential_id = ?');
        const result = statement.run(personName, credentialId);

        return result.changes > 0;
    }
}

export { HubPasskeyLimitError, MAX_HUB_PASSKEYS, SqliteHubPasskeyStore, createHubPasskeyTables };
export type { HubPasskeyRecord, HubPasskeyStore, HubPasskeyStoreOptions, NewHubPasskey };
