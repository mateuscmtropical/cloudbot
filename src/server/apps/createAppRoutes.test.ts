import { describe, expect, it } from 'vitest';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import { createAppRoutes } from './createAppRoutes.ts';

const APP: ConnectedAppSummary = { id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 };

describe('app routes', () => {
    it('lists the connected servers without tokens', async () => {
        const routes = createAppRoutes({ connectedApps: { list: () => Promise.resolve([APP]), remove: () => Promise.resolve(false) } });
        const response = await routes.request('/api/apps');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual([APP]);
    });

    it('removes a server by id, and answers 404 for an unknown id', async () => {
        const removed: string[] = [];
        const routes = createAppRoutes({
            connectedApps: {
                list: () => Promise.resolve([]),
                remove: (id) => {
                    removed.push(id);

                    return Promise.resolve(id === 'app-1');
                },
            },
        });

        expect((await routes.request('/api/apps/app-1', { method: 'DELETE' })).status)
            .toBe(204);
        expect((await routes.request('/api/apps/app-9', { method: 'DELETE' })).status)
            .toBe(404);
        expect(removed)
            .toEqual(['app-1', 'app-9']);
    });
});
