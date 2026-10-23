import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB_DATABASE_FILE = 'hub.db';
const IN_MEMORY_PATH = ':memory:';

const CREATE_PEOPLE_TABLE = `
    CREATE TABLE IF NOT EXISTS people (
        name TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        state TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL,
        instance_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
    )
`;

// The hub keeps its own small database, apart from the databases of the instances. Each part of the hub that needs
// a table makes it with its own create function and the hub main calls them after this one.
function openHubDatabase(dataDir: string): DatabaseSync {
    const isInMemory = dataDir === IN_MEMORY_PATH;

    if (!isInMemory) {
        mkdirSync(dataDir, { recursive: true });
    }

    const databasePath = isInMemory ? IN_MEMORY_PATH : join(dataDir, HUB_DATABASE_FILE);
    const database = new DatabaseSync(databasePath);

    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(CREATE_PEOPLE_TABLE);

    return database;
}

export { openHubDatabase };
