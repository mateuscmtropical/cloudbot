import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexHomeFor, prepareCodexHome } from './codexHome.ts';

const BOT_ID = '0f8e1c2a-4b5d-4e6f-8a9b-0c1d2e3f4a5b';

describe('codexHome', () => {
    let dataDir: string;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-codex-home-'));
    });

    afterEach(async () => {
        await rm(dataDir, { recursive: true, force: true });
    });

    it('gives each bot its own folder in the data folder', () => {
        expect(codexHomeFor(dataDir, BOT_ID))
            .toBe(join(dataDir, 'codex', BOT_ID));
    });

    it('refuses a bot id that is not a UUID, so the folder cannot leave the codex folder', () => {
        expect(() => codexHomeFor(dataDir, '../other'))
            .toThrow('not valid');
        expect(() => codexHomeFor(dataDir, ''))
            .toThrow('not valid');
    });

    it('makes the folder private, since Codex keeps its sign-in there', async () => {
        const home = await prepareCodexHome(dataDir, BOT_ID);
        const info = await stat(home);

        expect(info.isDirectory())
            .toBe(true);
        if (process.platform !== 'win32') {
            expect(info.mode & 0o777)
                .toBe(0o700);
        }
    });
});
