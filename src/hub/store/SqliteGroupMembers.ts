import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { GroupMember, GroupRole } from '../../shared/peopleTypes.ts';
import type { GroupMembersStore } from '../contract.ts';

type Row = Record<string, SQLOutputValue>;

// A row goes away with its group or its person, so nobody keeps a place in a group that is gone.
const CREATE_GROUP_MEMBERS_TABLE = `
    CREATE TABLE IF NOT EXISTS group_members (
        group_name TEXT NOT NULL REFERENCES people (name) ON DELETE CASCADE,
        person_name TEXT NOT NULL REFERENCES people (name) ON DELETE CASCADE,
        role TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (group_name, person_name)
    )
`;

function createGroupMemberTables(database: DatabaseSync): void {
    database.exec(CREATE_GROUP_MEMBERS_TABLE);
    database.exec('CREATE INDEX IF NOT EXISTS group_members_person_idx ON group_members (person_name)');
}

function readText(row: Row, column: string): string {
    const value = row[column];

    return typeof value === 'string' ? value : '';
}

class SqliteGroupMembers implements GroupMembersStore {
    private readonly database: DatabaseSync;

    constructor(database: DatabaseSync) {
        this.database = database;
    }

    list(groupName: string): GroupMember[] {
        const statement = this.database.prepare('SELECT person_name, role FROM group_members WHERE group_name = ? ORDER BY added_at, person_name');
        const rows = statement.all(groupName);

        return rows.map(row => ({ name: readText(row, 'person_name'), role: readText(row, 'role') as GroupRole }));
    }

    groupsOf(personName: string): GroupMember[] {
        const statement = this.database.prepare('SELECT group_name, role FROM group_members WHERE person_name = ? ORDER BY added_at, group_name');
        const rows = statement.all(personName);

        return rows.map(row => ({ name: readText(row, 'group_name'), role: readText(row, 'role') as GroupRole }));
    }

    roleOf(groupName: string, personName: string): GroupRole | undefined {
        const statement = this.database.prepare('SELECT role FROM group_members WHERE group_name = ? AND person_name = ?');
        const row = statement.get(groupName, personName);

        return row === undefined ? undefined : readText(row, 'role') as GroupRole;
    }

    set(groupName: string, personName: string, role: GroupRole, now: number): void {
        const statement = this.database.prepare('INSERT INTO group_members (group_name, person_name, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (group_name, person_name) DO UPDATE SET role = excluded.role');

        statement.run(groupName, personName, role, now);
    }

    remove(groupName: string, personName: string): void {
        const statement = this.database.prepare('DELETE FROM group_members WHERE group_name = ? AND person_name = ?');

        statement.run(groupName, personName);
    }
}

export { createGroupMemberTables, SqliteGroupMembers };
