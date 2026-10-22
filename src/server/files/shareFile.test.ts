import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShareFileError, cleanShareName, guessMimeType, isSameFile, shareWorkspaceFile } from './shareFile.ts';

const FILE_ID = '11111111-1111-4111-8111-111111111111';

// Windows only lets an account make file symlinks with Developer Mode or admin rights.
function canMakeSymlinks(): boolean {
    const probeDir = mkdtempSync(join(tmpdir(), 'cloudbot-symlink-probe-'));

    try {
        symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'));

        return true;
    } catch {
        return false;
    } finally {
        rmSync(probeDir, { recursive: true, force: true });
    }
}

const SYMLINKS_ALLOWED = canMakeSymlinks();

describe('shareWorkspaceFile', () => {
    let rootDir: string;
    let workspaceDir: string;
    let shareDir: string;

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'cloudbot-share-'));
        workspaceDir = join(rootDir, 'workspace');
        shareDir = join(rootDir, 'shared');
        await mkdir(workspaceDir);
        await mkdir(shareDir);
    });

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });

    function share(requestedPath: string, maxBytes = 1024): ReturnType<typeof shareWorkspaceFile> {
        return shareWorkspaceFile({ workspaceDir, requestedPath, shareDir, maxBytes, fileId: FILE_ID });
    }

    it('refuses a text file that holds a card number, and copies nothing', async () => {
        await writeFile(join(workspaceDir, 'cards.txt'), 'Visa 4111 1111 1111 1111\n');

        const attempt = share('cards.txt');

        await expect(attempt)
            .rejects.toThrow('payment card number');
        expect(await readdir(shareDir))
            .toEqual([]);
    });

    it('does not scan a binary file, so its bytes are copied as they are', async () => {
        const bytes = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('4111 1111 1111 1111')]);

        await writeFile(join(workspaceDir, 'image.bin'), bytes);

        const copy = await share('image.bin');

        expect(copy.sizeBytes)
            .toBe(bytes.length);
    });

    it('copies a file given by a relative path', async () => {
        await mkdir(join(workspaceDir, 'out'));
        await writeFile(join(workspaceDir, 'out', 'report.csv'), 'a,b\n1,2\n');

        const copy = await share('out/report.csv');

        expect(copy)
            .toEqual({ id: FILE_ID, name: 'report.csv', mimeType: 'text/csv', sizeBytes: 8 });
        expect(await readFile(join(shareDir, FILE_ID), 'utf8'))
            .toBe('a,b\n1,2\n');
    });

    it('copies a file given by an absolute path inside the workspace', async () => {
        await writeFile(join(workspaceDir, 'a.txt'), 'hi');

        const copy = await share(join(workspaceDir, 'a.txt'));

        expect(copy.name)
            .toBe('a.txt');
    });

    it('keeps the copy when the original changes later', async () => {
        await writeFile(join(workspaceDir, 'a.txt'), 'before');
        await share('a.txt');
        await writeFile(join(workspaceDir, 'a.txt'), 'after');

        expect(await readFile(join(shareDir, FILE_ID), 'utf8'))
            .toBe('before');
    });

    it('refuses a path outside the workspace', async () => {
        await writeFile(join(rootDir, 'secret.txt'), 'secret');

        await expect(share('../secret.txt'))
            .rejects
            .toThrow('inside your workspace');
        await expect(share(join(rootDir, 'secret.txt')))
            .rejects
            .toBeInstanceOf(ShareFileError);
        expect(await readdir(shareDir))
            .toEqual([]);
    });

    it.skipIf(!SYMLINKS_ALLOWED)('refuses a symlink that leads out of the workspace', async () => {
        await writeFile(join(rootDir, 'secret.txt'), 'secret');
        await symlink(join(rootDir, 'secret.txt'), join(workspaceDir, 'link.txt'));

        await expect(share('link.txt'))
            .rejects
            .toThrow('inside your workspace');
    });

    it('refuses a symlinked folder that leads out of the workspace', async () => {
        await writeFile(join(rootDir, 'secret.txt'), 'secret');
        // A junction works on Windows without special rights, and the type is ignored elsewhere.
        await symlink(rootDir, join(workspaceDir, 'up'), 'junction');

        await expect(share('up/secret.txt'))
            .rejects
            .toThrow('inside your workspace');
    });

    it('refuses a folder and the workspace itself', async () => {
        await mkdir(join(workspaceDir, 'dir'));

        await expect(share('dir'))
            .rejects
            .toThrow('regular files');
        await expect(share('.'))
            .rejects
            .toThrow('inside your workspace');
    });

    it('refuses a missing file', async () => {
        await expect(share('missing.txt'))
            .rejects
            .toThrow('No file exists');
    });

    it('refuses a file over the size limit and leaves no copy', async () => {
        await writeFile(join(workspaceDir, 'big.bin'), Buffer.alloc(11));

        await expect(share('big.bin', 10))
            .rejects
            .toThrow('larger than');
        expect(await readdir(shareDir))
            .toEqual([]);
    });
});

describe('guessMimeType', () => {
    it('knows common types and keeps html and unknown types as octet-stream', () => {
        expect(guessMimeType('a.PDF'))
            .toBe('application/pdf');
        expect(guessMimeType('a.html'))
            .toBe('application/octet-stream');
        expect(guessMimeType('a.svg'))
            .toBe('application/octet-stream');
        expect(guessMimeType('noext'))
            .toBe('application/octet-stream');
    });
});

describe('isSameFile', () => {
    it('matches a file with itself and refuses a different file with the same content', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'cloudbot-same-file-'));

        try {
            await writeFile(join(dir, 'first.txt'), 'same');
            await writeFile(join(dir, 'second.txt'), 'same');

            const first = await stat(join(dir, 'first.txt'), { bigint: true });
            const firstAgain = await stat(join(dir, 'first.txt'), { bigint: true });
            const second = await stat(join(dir, 'second.txt'), { bigint: true });

            expect(isSameFile(first, firstAgain))
                .toBe(true);
            expect(isSameFile(first, second))
                .toBe(false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('never matches when the filesystem reports inode 0 for every file', () => {
        const zeroInode = { dev: 1n, ino: 0n } as BigIntStats;

        expect(isSameFile(zeroInode, zeroInode))
            .toBe(false);
    });
});

describe('cleanShareName', () => {
    it('removes control characters and falls back to file', () => {
        expect(cleanShareName('a\nb\u0000.txt'))
            .toBe('ab.txt');
        expect(cleanShareName('  '))
            .toBe('file');
        expect(cleanShareName('x'.repeat(300)))
            .toHaveLength(120);
    });
});

describe('shareWorkspaceFile edge cases', () => {
    let rootDir: string;
    let workspaceDir: string;
    let shareDir: string;

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'cloudbot-share-edge-'));
        workspaceDir = join(rootDir, 'workspace');
        shareDir = join(rootDir, 'shared');
        await mkdir(workspaceDir);
        await mkdir(shareDir);
    });

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true });
    });

    it('accepts a file whose name starts with two dots', async () => {
        await writeFile(join(workspaceDir, '..notes.txt'), 'hi');

        const copy = await shareWorkspaceFile({ workspaceDir, requestedPath: '..notes.txt', shareDir, maxBytes: 100, fileId: FILE_ID });

        expect(copy.name)
            .toBe('..notes.txt');
    });

    it.skipIf(process.platform === 'win32')('refuses a named pipe without waiting for a writer', async () => {
        execFileSync('mkfifo', [join(workspaceDir, 'pipe')]);

        await expect(shareWorkspaceFile({ workspaceDir, requestedPath: 'pipe', shareDir, maxBytes: 100, fileId: FILE_ID }))
            .rejects
            .toThrow('regular files');
        expect(await readdir(shareDir))
            .toEqual([]);
    });
});
