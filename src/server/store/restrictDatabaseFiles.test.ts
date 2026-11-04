import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openHubDatabase } from '../../hub/store/openHubDatabase.ts';
import { restrictDatabaseFiles } from './restrictDatabaseFiles.ts';

function readMode(path: string): number {
    const stats = statSync(path);

    return stats.mode & 0o777;
}

describe('restrictDatabaseFiles', () => {
    const folders: string[] = [];

    afterEach(() => {
        folders.splice(0)
            .forEach((folder) => {
                rmSync(folder, { recursive: true, force: true });
            });
    });

    // Windows has no such modes.
    it.skipIf(process.platform === 'win32')('makes the hub database and its side files private', () => {
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-db-mode-'));

        folders.push(folder);
        const database = openHubDatabase(folder);

        database.exec('CREATE TABLE sample (id INTEGER)');

        const modes = ['hub.db', 'hub.db-wal', 'hub.db-shm'].map(file => readMode(join(folder, file)));

        database.close();
        expect(modes)
            .toEqual([0o600, 0o600, 0o600]);
    });

    it('does not throw for a file that does not exist', () => {
        const folder = mkdtempSync(join(tmpdir(), 'cloudbot-db-mode-'));

        folders.push(folder);
        expect(() => {
            restrictDatabaseFiles(join(folder, 'missing.db'));
        }).not.toThrow();
    });
});
