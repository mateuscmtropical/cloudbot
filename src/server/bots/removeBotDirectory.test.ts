import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { removeBotDirectory } from './removeBotDirectory.ts';

const IS_WINDOWS = process.platform === 'win32';

function pathExists(path: string): Promise<boolean> {
    return lstat(path)
        .then(() => true)
        .catch(() => false);
}

describe('removeBotDirectory', () => {
    let base: string;
    let root: string;
    let outside: string;

    beforeEach(async () => {
        base = await mkdtemp(join(tmpdir(), 'cloudbot-remove-'));
        root = join(base, 'root');
        outside = join(base, 'outside');
        await mkdir(root);
        await mkdir(outside);
        await writeFile(join(outside, 'secret.txt'), 'keep me');
    });

    afterEach(async () => {
        await rm(base, { recursive: true, force: true });
    });

    it('removes the bot folder with everything in it', async () => {
        await mkdir(join(root, 'bot-1', 'nested'), { recursive: true });
        await writeFile(join(root, 'bot-1', 'nested', 'note.txt'), 'bye');

        await removeBotDirectory(root, 'bot-1');

        expect(await pathExists(join(root, 'bot-1')))
            .toBe(false);
        expect(await pathExists(root))
            .toBe(true);
    });

    it('does nothing when the bot has no folder', async () => {
        await expect(removeBotDirectory(root, 'bot-1'))
            .resolves.toBeUndefined();
    });

    it('refuses a bot id that could step out of the root, and removes nothing', async () => {
        await expect(removeBotDirectory(root, '../outside'))
            .rejects.toThrow('Invalid bot id');
        expect(await readFile(join(outside, 'secret.txt'), 'utf8'))
            .toBe('keep me');
    });

    it.skipIf(IS_WINDOWS)('removes a link at the bot path without following it', async () => {
        await symlink(outside, join(root, 'bot-1'), 'dir');

        await removeBotDirectory(root, 'bot-1');

        expect(await pathExists(join(root, 'bot-1')))
            .toBe(false);
        expect(await readFile(join(outside, 'secret.txt'), 'utf8'))
            .toBe('keep me');
    });

    it.skipIf(IS_WINDOWS)('keeps the files behind a link inside the bot folder', async () => {
        await mkdir(join(root, 'bot-1'));
        await symlink(outside, join(root, 'bot-1', 'link'), 'dir');

        await removeBotDirectory(root, 'bot-1');

        expect(await pathExists(join(root, 'bot-1')))
            .toBe(false);
        expect(await readFile(join(outside, 'secret.txt'), 'utf8'))
            .toBe('keep me');
    });
});
