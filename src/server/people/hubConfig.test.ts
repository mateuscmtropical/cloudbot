import { describe, expect, it } from 'vitest';

import { readHubConfig } from './hubConfig.ts';

describe('readHubConfig', () => {
    it('returns undefined when the server runs on its own', () => {
        expect(readHubConfig({}))
            .toBeUndefined();
        expect(readHubConfig({ CLOUDBOT_HUB_SECRET: '' }))
            .toBeUndefined();
    });

    it('reads a full configuration', () => {
        const config = readHubConfig({
            CLOUDBOT_HUB_SECRET: 'secret',
            CLOUDBOT_HUB_URL: 'http://hub:3001',
            CLOUDBOT_PERSON_NAME: 'maria',
            CLOUDBOT_PERSON_ROLE: 'member',
        });

        expect(config)
            .toEqual({ hubUrl: 'http://hub:3001', secret: 'secret', personName: 'maria', role: 'member' });
    });

    it('stops the start when the configuration is half set', () => {
        expect(() => readHubConfig({ CLOUDBOT_HUB_SECRET: 'secret', CLOUDBOT_PERSON_ROLE: 'owner' }))
            .toThrow('CLOUDBOT_HUB_URL');
        expect(() => readHubConfig({ CLOUDBOT_HUB_SECRET: 'secret', CLOUDBOT_HUB_URL: 'http://hub:3001', CLOUDBOT_PERSON_NAME: 'maria', CLOUDBOT_PERSON_ROLE: 'boss' }))
            .toThrow('CLOUDBOT_PERSON_ROLE');
    });
});
