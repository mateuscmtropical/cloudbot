import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AppUpdateRequests } from './AppUpdateRequests.ts';

const COMMIT = 'a'.repeat(40);
const LATEST = 'b'.repeat(40);

function makeFolder(status?: string): string {
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-update-'));

    if (status !== undefined) {
        writeFileSync(join(folder, 'update-status.json'), status);
    }

    return folder;
}

function statusText(state: string): string {
    return JSON.stringify({ state, commit: COMMIT, latest: LATEST, at: '2026-11-05T10:00:00Z' });
}

describe('AppUpdateRequests', () => {
    it.each([
        ['no status file', undefined],
        ['broken text', 'not json'],
        ['an unknown state', statusText('odd')],
        ['a commit that is not one', JSON.stringify({ state: 'idle', commit: '<b>', latest: LATEST, at: 'now' })],
    ])('has no update with %s, and starts none', (_name, status) => {
        const folder = makeFolder(status);
        const updates = new AppUpdateRequests(folder);

        expect(updates.status())
            .toEqual({ state: 'unavailable' });
        expect(updates.start())
            .toBeUndefined();
        expect(existsSync(join(folder, 'update-request')))
            .toBe(false);
    });

    it('leaves the request file for the server when it starts', () => {
        const folder = makeFolder(statusText('idle'));
        const updates = new AppUpdateRequests(folder);

        expect(updates.status())
            .toMatchObject({ state: 'idle', commit: COMMIT, latest: LATEST });
        expect(updates.start())
            .toMatchObject({ state: 'running' });
        expect(existsSync(join(folder, 'update-request')))
            .toBe(true);
    });

    it('starts no second update while one runs', () => {
        const folder = makeFolder(statusText('running'));
        const updates = new AppUpdateRequests(folder);

        expect(updates.start())
            .toBeUndefined();
        expect(existsSync(join(folder, 'update-request')))
            .toBe(false);
    });
});
