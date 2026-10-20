import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AsyncRemoteCallback } from 'drizzle-orm/sqlite-proxy';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator';

import * as schema from './schema.ts';
import type { AppDatabase } from './types.ts';

interface OpenDatabaseOptions {
    migrationsFolder?: string;
}

interface OpenedDatabase {
    db: AppDatabase;
    sqlite: DatabaseSync;
    close: () => void;
}

type SqliteBinding = number | string | bigint | null | Uint8Array;
type RemoteMethod = 'run' | 'all' | 'values' | 'get';

const IN_MEMORY_PATH = ':memory:';
const DEFAULT_MIGRATIONS_FOLDER = 'drizzle';

// Drizzle sends SQL plus bound values. node:sqlite runs it and returns rows as
// arrays of values, which is the shape Drizzle expects from a proxy. The Node
// typings still describe rows as objects, so the result is cast to unknown.
function executeStatement(sqlite: DatabaseSync, sql: string, params: unknown[], method: RemoteMethod): { rows: unknown[] } {
    const statement = sqlite.prepare(sql);
    const bindings = params as SqliteBinding[];

    if (method === 'run') {
        statement.run(...bindings);

        return { rows: [] };
    }

    statement.setReturnArrays(true);

    if (method === 'get') {
        const row: unknown = statement.get(...bindings);

        // Drizzle reads the whole `rows` value as one row and treats undefined as no row.
        return { rows: row as unknown[] };
    }

    const rows: unknown = statement.all(...bindings);

    return { rows: rows as unknown[] };
}

function createRemoteCallback(sqlite: DatabaseSync): AsyncRemoteCallback {
    return (sql, params, method) => {
        const result = executeStatement(sqlite, sql, params, method);

        return Promise.resolve(result);
    };
}

// The migrator hands over plain SQL strings with no transaction around them.
// Each migration must apply all or nothing, so BEGIN and COMMIT run here.
// A throw inside the Promise executor becomes a rejection, so the error reaches migrate.
function applyMigrationQueries(sqlite: DatabaseSync, queries: string[]): Promise<void> {
    return new Promise<void>((resolve) => {
        sqlite.exec('BEGIN');

        try {
            queries.forEach((query) => {
                sqlite.exec(query);
            });
            sqlite.exec('COMMIT');
        } catch (error: unknown) {
            sqlite.exec('ROLLBACK');

            throw error;
        }

        resolve();
    });
}

async function openDatabase(filePath: string, options: OpenDatabaseOptions = {}): Promise<OpenedDatabase> {
    if (filePath !== IN_MEMORY_PATH) {
        const folderPath = dirname(filePath);

        mkdirSync(folderPath, { recursive: true });
    }

    const sqlite = new DatabaseSync(filePath);

    // Drizzle has no API for pragmas, so they run on the raw handle.
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA foreign_keys = ON');

    const remoteCallback = createRemoteCallback(sqlite);
    const db = drizzle(remoteCallback, { schema });
    const migrationsFolder = options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;

    try {
        await migrate(db, queries => applyMigrationQueries(sqlite, queries), { migrationsFolder });
    } catch (error: unknown) {
        sqlite.close();

        throw error;
    }

    return {
        db,
        sqlite,
        close: () => {
            sqlite.close();
        },
    };
}

export { openDatabase };
export type { OpenDatabaseOptions, OpenedDatabase };
