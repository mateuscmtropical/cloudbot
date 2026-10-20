import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databasePath, resolveDataDir } from './resolveDataDir.ts';

describe('resolveDataDir', () => {
    let savedDataDir: string | undefined;

    beforeEach(() => {
        savedDataDir = process.env.CLOUDBOT_DATA_DIR;
        delete process.env.CLOUDBOT_DATA_DIR;
    });

    afterEach(() => {
        if (savedDataDir === undefined) {
            delete process.env.CLOUDBOT_DATA_DIR;
        } else {
            process.env.CLOUDBOT_DATA_DIR = savedDataDir;
        }
    });

    it('defaults to the data folder in the working directory', () => {
        expect(resolveDataDir())
            .toBe('./data');
    });

    it('uses CLOUDBOT_DATA_DIR when it is set', () => {
        process.env.CLOUDBOT_DATA_DIR = '/var/lib/cloudbot';

        expect(resolveDataDir())
            .toBe('/var/lib/cloudbot');
    });

    it('puts the database file inside the data folder', () => {
        expect(databasePath('/var/lib/cloudbot'))
            .toBe(join('/var/lib/cloudbot', 'cloudbot.db'));
    });
});
