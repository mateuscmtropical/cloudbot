import { describe, expect, it } from 'vitest';

import { readHubSettings } from './config.ts';

describe('readHubSettings', () => {
    it('reads defaults when the required domain and container id are present', () => {
        const settings = readHubSettings({ CLOUDBOT_DOMAIN: 'example.com', HOSTNAME: 'hub-container' });

        expect(settings)
            .toEqual({
                domain: 'example.com',
                port: 3001,
                host: '0.0.0.0',
                dataDir: '/var/lib/cloudbot-hub',
                dockerApiUrl: 'http://docker-proxy:2375',
                instanceImage: 'cloudbot:local',
                instanceMemoryMb: 2560,
                instanceBudgetMb: 10240,
                instanceCpus: 1.5,
                ownerName: 'owner',
                containerId: 'hub-container',
            });
    });

    it('accepts localhost and configured values', () => {
        const settings = readHubSettings({
            CLOUDBOT_DOMAIN: 'localhost',
            HUB_CONTAINER_ID: 'hub-id',
            HUB_PORT: '3201',
            CLOUDBOT_INSTANCE_MEMORY_MB: '1024',
            CLOUDBOT_INSTANCE_BUDGET_MB: '4096',
            CLOUDBOT_INSTANCE_CPUS: '2.25',
        });

        expect(settings.port)
            .toBe(3201);
        expect(settings.instanceMemoryMb)
            .toBe(1024);
        expect(settings.instanceBudgetMb)
            .toBe(4096);
        expect(settings.instanceCpus)
            .toBe(2.25);
    });

    it('fails with clear messages for missing and invalid settings', () => {
        expect(() => readHubSettings({ HOSTNAME: 'hub-id' }))
            .toThrow('CLOUDBOT_DOMAIN is required.');
        expect(() => readHubSettings({ CLOUDBOT_DOMAIN: 'example.com' }))
            .toThrow('HUB_CONTAINER_ID is required.');
        expect(() => readHubSettings({ CLOUDBOT_DOMAIN: 'example.com', HUB_CONTAINER_ID: 'hub-id', HUB_PORT: '0' }))
            .toThrow('HUB_PORT must be a positive integer.');
        expect(() => readHubSettings({ CLOUDBOT_DOMAIN: 'example.com', HUB_CONTAINER_ID: 'hub-id', CLOUDBOT_INSTANCE_CPUS: 'NaN' }))
            .toThrow('CLOUDBOT_INSTANCE_CPUS must be a positive number.');
        expect(() => readHubSettings({ CLOUDBOT_DOMAIN: 'example.com', HUB_CONTAINER_ID: 'hub-id', CLOUDBOT_OWNER_NAME: 'Hub' }))
            .toThrow('CLOUDBOT_OWNER_NAME is invalid:');
    });
});
