import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = new URL('../../../drizzle/0028_message_search.sql', import.meta.url);

interface IndexRow {
    sequence: number;
}

describe('0028_message_search migration', () => {
    it('indexes the messages that already exist, without tool rows', () => {
        const database = new DatabaseSync(':memory:');

        database.exec('CREATE TABLE messages (sequence INTEGER PRIMARY KEY, kind TEXT, content TEXT)');
        database.exec(`INSERT INTO messages VALUES
            (1, 'text', '{"kind":"text","text":"old tea"}'),
            (2, 'toolActivity', '{"kind":"toolActivity","summary":"tea"}'),
            (3, 'file', '{"kind":"file","name":"tea.pdf"}')`);

        database.exec(readFileSync(MIGRATION_PATH, 'utf8'));

        const statement = database.prepare('SELECT rowid AS sequence FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid');
        const rows = statement.all('tea') as unknown as IndexRow[];
        const sequences = rows.map(row => row.sequence);

        expect(sequences)
            .toEqual([1, 3]);

        database.close();
    });
});
