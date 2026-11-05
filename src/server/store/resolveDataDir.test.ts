import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { databasePath } from './resolveDataDir.ts';

describe('databasePath', () => {
    it('puts the database file inside the data folder', () => {
        expect(databasePath('/var/lib/cloudbot'))
            .toBe(join('/var/lib/cloudbot', 'cloudbot.db'));
    });
});
