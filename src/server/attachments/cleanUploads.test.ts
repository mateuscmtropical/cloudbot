import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUploadRetentionMs, removeOldUploads } from './cleanUploads.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 9, 21);

let uploadRoot = '';

async function writeAgedFile(botId: string, name: string, ageDays: number): Promise<string> {
    const folder = join(uploadRoot, botId);

    await mkdir(folder, { recursive: true });

    const path = join(folder, name);
    const modifiedAt = new Date(NOW_MS - ageDays * DAY_MS);

    await writeFile(path, 'data');
    await utimes(path, modifiedAt, modifiedAt);

    return path;
}

beforeEach(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'cloudbot-clean-'));
});

afterEach(async () => {
    await rm(uploadRoot, { recursive: true, force: true });
});

describe('removeOldUploads', () => {
    it('removes files older than the limit and keeps newer ones', async () => {
        const oldPath = await writeAgedFile('bot-1', 'old.txt', 40);
        const newPath = await writeAgedFile('bot-1', 'new.txt', 5);
        const otherBotPath = await writeAgedFile('bot-2', 'old.txt', 31);

        const removed = await removeOldUploads({
            uploadRoot, isProtected: () => false, maxAgeMs: 30 * DAY_MS, nowMs: NOW_MS,
        });

        expect(removed.sort())
            .toEqual([oldPath, otherBotPath].sort());
        expect(existsSync(oldPath))
            .toBe(false);
        expect(existsSync(otherBotPath))
            .toBe(false);
        expect(existsSync(newPath))
            .toBe(true);
    });

    it('keeps an old file that a queued message still needs', async () => {
        const queuedPath = await writeAgedFile('bot-1', 'queued.txt', 60);

        const removed = await removeOldUploads({
            uploadRoot, isProtected: (_botId, path) => path === queuedPath, maxAgeMs: 30 * DAY_MS, nowMs: NOW_MS,
        });

        expect(removed)
            .toEqual([]);
        expect(existsSync(queuedPath))
            .toBe(true);
    });

    it('does nothing when the upload folder does not exist', async () => {
        const removed = await removeOldUploads({
            uploadRoot: join(uploadRoot, 'missing'), isProtected: () => false, maxAgeMs: DAY_MS, nowMs: NOW_MS,
        });

        expect(removed)
            .toEqual([]);
    });
});

describe('readUploadRetentionMs', () => {
    it('reads the days from the environment', () => {
        expect(readUploadRetentionMs({ CLOUDBOT_UPLOAD_RETENTION_DAYS: '7' }))
            .toBe(7 * DAY_MS);
    });

    it.each(['', 'abc', '0', '-3'])('uses 15 days for the value "%s"', (value) => {
        expect(readUploadRetentionMs({ CLOUDBOT_UPLOAD_RETENTION_DAYS: value }))
            .toBe(15 * DAY_MS);
    });

    it('uses 15 days when the variable is missing', () => {
        expect(readUploadRetentionMs({}))
            .toBe(15 * DAY_MS);
    });
});
