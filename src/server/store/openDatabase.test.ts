import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

const FAILING_JOURNAL = {
    version: '7',
    dialect: 'sqlite',
    entries: [
        { idx: 0, version: '6', when: 1700000000000, tag: '0000_failing', breakpoints: true },
    ],
};

describe('openDatabase', () => {
    let temporaryDir: string;
    let opened: OpenedDatabase | undefined;

    beforeEach(() => {
        temporaryDir = mkdtempSync(join(tmpdir(), 'cloudbot-store-'));
        opened = undefined;
    });

    afterEach(() => {
        opened?.close();
        rmSync(temporaryDir, { recursive: true, force: true });
    });

    it('creates the tables and enables foreign keys in memory', async () => {
        opened = await openDatabase(':memory:');
        const foreignKeyRow = opened.sqlite.prepare('PRAGMA foreign_keys')
            .get();
        const botStore = new BotStore(opened.db);

        expect(foreignKeyRow?.foreign_keys)
            .toBe(1);
        await expect(botStore.list())
            .resolves.toEqual([]);
    });

    it('creates the data folder when it does not exist', async () => {
        const databaseFile = join(temporaryDir, 'nested', 'cloudbot.db');

        opened = await openDatabase(databaseFile);

        expect(existsSync(databaseFile))
            .toBe(true);
    });

    it('keeps the data when the same file is opened again', async () => {
        const databaseFile = join(temporaryDir, 'cloudbot.db');
        const firstOpened = await openDatabase(databaseFile);
        const firstStore = new BotStore(firstOpened.db);

        await firstStore.create({ name: 'Ana', title: '', description: '' });
        firstOpened.close();

        opened = await openDatabase(databaseFile);
        const secondStore = new BotStore(opened.db);

        await expect(secondStore.list())
            .resolves.toHaveLength(1);
    });

    it('rolls back a migration that fails halfway', async () => {
        const migrationsFolder = join(temporaryDir, 'drizzle');
        const journalFolder = join(migrationsFolder, 'meta');
        const databaseFile = join(temporaryDir, 'cloudbot.db');

        mkdirSync(journalFolder, { recursive: true });
        writeFileSync(join(journalFolder, '_journal.json'), JSON.stringify(FAILING_JOURNAL));
        writeFileSync(
            join(migrationsFolder, '0000_failing.sql'),
            'CREATE TABLE half_done (id integer);\n--> statement-breakpoint\nTHIS IS NOT SQL',
        );

        await expect(openDatabase(databaseFile, { migrationsFolder }))
            .rejects.toThrow();

        // The raw handle is used because half_done is not part of the schema.
        const rawDatabase = new DatabaseSync(databaseFile);
        const halfDoneRows = rawDatabase.prepare('SELECT name FROM sqlite_master WHERE name = ?')
            .all('half_done');

        rawDatabase.close();

        expect(halfDoneRows)
            .toEqual([]);
    });
});
