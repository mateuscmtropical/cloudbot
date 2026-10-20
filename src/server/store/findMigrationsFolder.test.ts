import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { findMigrationsFolder } from './findMigrationsFolder.ts';

const STORE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const createdDirectories: string[] = [];

describe('findMigrationsFolder', () => {
    afterEach(async () => {
        const directories = createdDirectories.splice(0);

        await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    });

    it('finds the repository drizzle folder from the store source folder', () => {
        const folder = findMigrationsFolder(STORE_DIRECTORY);

        expect(folder)
            .toBe(join(STORE_DIRECTORY, '..', '..', '..', 'drizzle'));
    });

    it('finds the drizzle folder from the bundled dist/server folder', async () => {
        const installRoot = await mkdtemp(join(tmpdir(), 'cloudbot-install-'));
        const journalFolder = join(installRoot, 'drizzle', 'meta');
        const bundledFolder = join(installRoot, 'dist', 'server');

        createdDirectories.push(installRoot);
        await mkdir(journalFolder, { recursive: true });
        await mkdir(bundledFolder, { recursive: true });
        await writeFile(join(journalFolder, '_journal.json'), '{}');

        expect(findMigrationsFolder(bundledFolder))
            .toBe(join(installRoot, 'drizzle'));
    });

    it('throws when no drizzle folder exists above the start folder', async () => {
        const emptyRoot = await mkdtemp(join(tmpdir(), 'cloudbot-empty-'));

        createdDirectories.push(emptyRoot);

        expect(() => findMigrationsFolder(emptyRoot))
            .toThrow('Could not find the drizzle migrations folder.');
    });
});
