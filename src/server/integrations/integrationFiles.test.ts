import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { IntegrationError, readEntryFile } from './integrationFiles.ts';

let workspace: string;
let outside: string;

beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'integration-files-'));

    workspace = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, 'post.js'), 'console.log(1)');
    await writeFile(join(outside, 'secret.js'), 'console.log(2)');
});

async function refusalOf(entryPath: string): Promise<string | undefined> {
    try {
        await readEntryFile(workspace, entryPath);

        return undefined;
    } catch (error: unknown) {
        return error instanceof IntegrationError ? error.message : 'other error';
    }
}

describe('readEntryFile', () => {
    it('reads a file inside the workspace', async () => {
        expect((await readEntryFile(workspace, 'post.js')).toString())
            .toBe('console.log(1)');
    });

    it('refuses a parent folder, an absolute path and an empty path', async () => {
        expect(await refusalOf('../outside/secret.js'))
            .toContain('without ".."');
        expect(await refusalOf(join(outside, 'secret.js')))
            .toContain('without ".."');
        expect(await refusalOf(''))
            .toContain('without ".."');
    });

    it('refuses a link inside the workspace that leads out of it', async () => {
        try {
            await symlink(join(outside, 'secret.js'), join(workspace, 'link.js'));
        } catch {
            // Creating a link needs a permission on some systems. Then the check is not run here.
            return;
        }

        expect(await refusalOf('link.js'))
            .toBe('The entry file must be inside the bot workspace.');
    });

    it('refuses a folder as the entry file', async () => {
        await mkdir(join(workspace, 'folder'));

        expect(await refusalOf('folder'))
            .toMatch(/regular file|could not be read/);
    });

    it('refuses a file over 256 KB, read or not', async () => {
        await writeFile(join(workspace, 'big.js'), Buffer.alloc(256 * 1024 + 1, 0x61));

        expect(await refusalOf('big.js'))
            .toBe('The entry file is larger than 256 KB.');
    });

    it('refuses a file that does not exist', async () => {
        expect(await refusalOf('missing.js'))
            .toBe('The entry file was not found in the bot workspace.');
    });
});
