import { Hono } from 'hono';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { ConnectedApps } from './ConnectedApps.ts';

interface AppErrorResponse {
    error: string;
}

// The connected servers are listed and removed here by the owner. These routes sit behind the session check.
interface AppRoutesOptions {
    connectedApps: Pick<ConnectedApps, 'list' | 'remove'>;
}

const APP_NOT_FOUND: AppErrorResponse = { error: 'No connected server has this id.' };

function createAppRoutes(options: AppRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/apps', async (context) => {
        const apps: ConnectedAppSummary[] = await options.connectedApps.list();

        return context.json(apps);
    });

    routes.delete('/api/apps/:id', async (context) => {
        const appId = context.req.param('id');
        const isRemoved = await options.connectedApps.remove(appId);

        if (!isRemoved) {
            return context.json(APP_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createAppRoutes };
export type { AppRoutesOptions };
