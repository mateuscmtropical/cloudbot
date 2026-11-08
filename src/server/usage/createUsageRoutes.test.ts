import { describe, expect, it, vi } from 'vitest';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { InstanceUsage, ServerUsage } from '../../shared/usageTypes.ts';
import type { HubConfig } from '../people/hubConfig.ts';
import { createUsageRoutes, fetchHubUsage } from './createUsageRoutes.ts';

const CONFIG: HubConfig = { hubUrl: 'http://hub:3001', secret: 'instance-secret', personName: 'maria', role: 'member' };
const OWN: InstanceUsage = { name: 'maria', role: 'member', instance: 'running', numbers: { cpuPercent: 10, cpuLimitPercent: 150, memoryBytes: 1, memoryLimitBytes: 2 } };
const SERVER: ServerUsage = {
    host: { cpuCount: 4, loadAverage: 1, memoryTotalBytes: 8, memoryUsedBytes: 4, diskTotalBytes: 100, diskUsedBytes: 50 },
    instances: [OWN],
};

describe('fetchHubUsage', () => {
    it('sends the name and the secret of this instance and returns the answer', async () => {
        const fakeFetch = vi.fn(() => Promise.resolve(Response.json(OWN)));

        const usage = await fetchHubUsage<InstanceUsage>(CONFIG, '/internal/my-usage', fakeFetch);

        expect(usage)
            .toEqual(OWN);
        expect(fakeFetch)
            .toHaveBeenCalledWith('http://hub:3001/internal/my-usage', { headers: { [INSTANCE_NAME_HEADER]: 'maria', [INSTANCE_SECRET_HEADER]: 'instance-secret' } });
    });

    it('gives nothing when the hub refuses, answers nonsense or is down', async () => {
        const refused = await fetchHubUsage(CONFIG, '/internal/usage', () => Promise.resolve(Response.json({ error: 'No.' }, { status: 401 })));
        const broken = await fetchHubUsage(CONFIG, '/internal/usage', () => Promise.resolve(new Response('not json')));
        const down = await fetchHubUsage(CONFIG, '/internal/usage', () => Promise.reject(new Error('down')));

        expect([refused, broken, down])
            .toEqual([undefined, undefined, undefined]);
    });
});

describe('usage routes of an instance', () => {
    it('serves only the own usage when the instance is not the owner\'s', async () => {
        const routes = createUsageRoutes({ readOwn: () => Promise.resolve(OWN) });

        const own = await routes.request('/api/usage/me');
        const server = await routes.request('/api/usage');

        expect(await own.json())
            .toEqual(OWN);
        expect(server.status)
            .toBe(404);
    });

    it('serves the machine and the instances on the owner\'s instance', async () => {
        const routes = createUsageRoutes({ readOwn: () => Promise.resolve(OWN), readServer: () => Promise.resolve(SERVER) });

        const server = await routes.request('/api/usage');

        expect(await server.json())
            .toEqual(SERVER);
    });

    it('answers 502 when the hub gave nothing, without a detail', async () => {
        const routes = createUsageRoutes({ readOwn: () => Promise.resolve(undefined), readServer: () => Promise.resolve(undefined) });

        const own = await routes.request('/api/usage/me');
        const server = await routes.request('/api/usage');

        expect([own.status, server.status])
            .toEqual([502, 502]);
        expect(await own.json())
            .toEqual({ error: 'Could not read the usage from the hub.' });
    });
});
