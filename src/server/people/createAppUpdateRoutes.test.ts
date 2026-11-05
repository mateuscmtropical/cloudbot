import { describe, expect, it, vi } from 'vitest';

import { createAppUpdateRoutes } from './createAppUpdateRoutes.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';

const STATUS = { state: 'idle' as const, commit: 'a', latest: 'b', at: 'now' };

describe('createAppUpdateRoutes', () => {
    it('answers the status and starts an update', async () => {
        const startUpdate = vi.fn(() => Promise.resolve({ ...STATUS, state: 'running' as const }));
        const routes = createAppUpdateRoutes({ appUpdater: { updateStatus: () => Promise.resolve(STATUS), startUpdate } });
        const read = await routes.request('/api/update');
        const started = await routes.request('/api/update', { method: 'POST' });

        expect(await read.json())
            .toEqual(STATUS);
        expect(await started.json())
            .toMatchObject({ state: 'running' });
        expect(startUpdate)
            .toHaveBeenCalledOnce();
    });

    it('passes on that an update runs, and hides any other failure', async () => {
        const conflict = createAppUpdateRoutes({ appUpdater: { updateStatus: () => Promise.reject(new Error('secret detail')), startUpdate: () => Promise.reject(new PeopleAdminError('An update is running.', 409)) } });
        const started = await conflict.request('/api/update', { method: 'POST' });
        const read = await conflict.request('/api/update');

        expect(started.status)
            .toBe(409);
        expect(read.status)
            .toBe(502);
        expect(await read.text()).not.toContain('secret');
    });
});
