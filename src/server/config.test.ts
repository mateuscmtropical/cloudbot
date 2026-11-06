import { describe, expect, it } from 'vitest';

import { readServerConfig } from './config.ts';

describe('readServerConfig data dir', () => {
    it('defaults to the data folder in the working directory', () => {
        expect(readServerConfig({}).dataDir)
            .toBe('./data');
    });

    it('uses CLOUDBOT_DATA_DIR when it is set', () => {
        expect(readServerConfig({ CLOUDBOT_DATA_DIR: '/var/lib/cloudbot' }).dataDir)
            .toBe('/var/lib/cloudbot');
    });
});

describe('readServerConfig ai-memory switch', () => {
    it('keeps ai-memory on by default and turns it off only for off', () => {
        expect(readServerConfig({}).aiMemoryEnabled)
            .toBe(true);
        expect(readServerConfig({ CLOUDBOT_AI_MEMORY: 'off' }).aiMemoryEnabled)
            .toBe(false);
    });
});
