import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = new URL('../../../drizzle/0016_no_yellow_mascot.sql', import.meta.url);

interface ColorRow {
    id: string;
    color: string;
}

function readColors(database: DatabaseSync, tableName: string, columnName: string): ColorRow[] {
    const statement = database.prepare(`SELECT id, ${columnName} AS color FROM ${tableName} ORDER BY id`);

    return statement.all() as unknown as ColorRow[];
}

describe('0016_no_yellow_mascot migration', () => {
    it('moves yellow bots and yellow channel posts to orange, and leaves other colors alone', () => {
        const database = new DatabaseSync(':memory:');

        database.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, mascot_color TEXT)');
        database.exec('CREATE TABLE channel_messages (id TEXT PRIMARY KEY, author_color TEXT)');
        database.exec('INSERT INTO bots VALUES (\'a\', \'yellow\'), (\'b\', \'blue\'), (\'c\', \'yellow\')');
        database.exec('INSERT INTO channel_messages VALUES (\'m1\', \'yellow\'), (\'m2\', \'mint\')');

        database.exec(readFileSync(MIGRATION_PATH, 'utf8'));

        expect(readColors(database, 'bots', 'mascot_color'))
            .toEqual([{ id: 'a', color: 'orange' }, { id: 'b', color: 'blue' }, { id: 'c', color: 'orange' }]);
        expect(readColors(database, 'channel_messages', 'author_color'))
            .toEqual([{ id: 'm1', color: 'orange' }, { id: 'm2', color: 'mint' }]);

        database.close();
    });
});
