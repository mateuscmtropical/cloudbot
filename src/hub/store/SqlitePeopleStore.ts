import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { PeopleStore, PersonRecord, PersonUpdate } from '../contract.ts';
import type { PersonRole, PersonState } from '../../shared/peopleTypes.ts';

type Row = Record<string, SQLOutputValue>;

function readText(row: Row, column: string): string {
    const value = row[column];

    return typeof value === 'string' ? value : '';
}

function readNumber(row: Row, column: string): number {
    const value = row[column];

    return typeof value === 'number' ? value : 0;
}

function toRecord(row: Row): PersonRecord {
    const lastSeenAt = row.last_seen_at;

    return {
        name: readText(row, 'name'),
        role: readText(row, 'role') as PersonRole,
        state: readText(row, 'state') as PersonState,
        passwordHash: readText(row, 'password_hash'),
        mustChangePassword: readNumber(row, 'must_change_password') === 1,
        instanceSecret: readText(row, 'instance_secret'),
        createdAt: readNumber(row, 'created_at'),
        lastSeenAt: typeof lastSeenAt === 'number' ? lastSeenAt : null,
    };
}

class SqlitePeopleStore implements PeopleStore {
    private readonly database: DatabaseSync;

    constructor(database: DatabaseSync) {
        this.database = database;
    }

    list(): PersonRecord[] {
        const statement = this.database.prepare('SELECT * FROM people ORDER BY created_at, name');
        const rows = statement.all();

        return rows.map(toRecord);
    }

    find(name: string): PersonRecord | undefined {
        const statement = this.database.prepare('SELECT * FROM people WHERE name = ?');
        const row = statement.get(name);

        return row === undefined ? undefined : toRecord(row);
    }

    add(record: PersonRecord): void {
        const statement = this.database.prepare('INSERT INTO people (name, role, state, password_hash, must_change_password, instance_secret, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

        statement.run(record.name, record.role, record.state, record.passwordHash, record.mustChangePassword ? 1 : 0, record.instanceSecret, record.createdAt, record.lastSeenAt);
    }

    update(name: string, update: PersonUpdate): void {
        const current = this.find(name);

        if (current === undefined) {
            return;
        }

        const next: PersonRecord = { ...current, ...update };
        const statement = this.database.prepare('UPDATE people SET state = ?, password_hash = ?, must_change_password = ?, last_seen_at = ? WHERE name = ?');

        statement.run(next.state, next.passwordHash, next.mustChangePassword ? 1 : 0, next.lastSeenAt, name);
    }

    remove(name: string): void {
        const statement = this.database.prepare('DELETE FROM people WHERE name = ?');

        statement.run(name);
    }
}

export { SqlitePeopleStore };
