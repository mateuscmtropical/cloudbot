import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KEY_FILE_NAME, loadOrCreateVapidKeys } from './loadVapidKeys.ts';

describe('loadOrCreateVapidKeys', () => {
    let dataDir: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-vapid-'));
    });

    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    it('makes a key once and loads the same key on the next start', () => {
        const first = loadOrCreateVapidKeys(dataDir);
        const second = loadOrCreateVapidKeys(dataDir);

        expect(second.publicKey)
            .toBe(first.publicKey);
        expect(second.privateJwk.d)
            .toBe(first.privateJwk.d);
        expect(Buffer.from(first.publicKey, 'base64url'))
            .toHaveLength(65);
    });

    it.skipIf(process.platform === 'win32')('keeps the key file readable by its owner only, and tightens a loosened file', async () => {
        loadOrCreateVapidKeys(dataDir);

        const keyPath = join(dataDir, KEY_FILE_NAME);
        const createdStats = await stat(keyPath);

        expect(createdStats.mode & 0o777)
            .toBe(0o600);

        await chmod(keyPath, 0o644);
        loadOrCreateVapidKeys(dataDir);

        const tightenedStats = await stat(keyPath);

        expect(tightenedStats.mode & 0o777)
            .toBe(0o600);
    });

    it('refuses a key file that does not hold a P-256 key', async () => {
        await writeFile(join(dataDir, KEY_FILE_NAME), JSON.stringify({ version: 1, privateJwk: { kty: 'EC', crv: 'P-256' } }));

        expect(() => loadOrCreateVapidKeys(dataDir))
            .toThrow('P-256');
    });
});
