import { Hono } from 'hono';

import type { AppUpdateStatus } from '../../shared/peopleTypes.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';

interface AppUpdater {
    updateStatus: () => Promise<AppUpdateStatus>;
    startUpdate: () => Promise<AppUpdateStatus>;
}

interface AppUpdateRoutesOptions {
    appUpdater: AppUpdater;
}

const CONFLICT = 409;
const BAD_GATEWAY = 502;
const FAILED_TEXT = 'Could not reach the hub.';

// The owner's update, behind the session check. No tool of the bot reaches it, so only a person can start one.
function createAppUpdateRoutes(options: AppUpdateRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/update', async (context) => {
        try {
            const status = await options.appUpdater.updateStatus();

            return context.json(status);
        } catch {
            return context.json({ error: FAILED_TEXT }, BAD_GATEWAY);
        }
    });

    routes.post('/api/update', async (context) => {
        try {
            const status = await options.appUpdater.startUpdate();

            return context.json(status);
        } catch (error: unknown) {
            if (error instanceof PeopleAdminError && error.status === CONFLICT) {
                return context.json({ error: error.message }, CONFLICT);
            }

            return context.json({ error: FAILED_TEXT }, BAD_GATEWAY);
        }
    });

    return routes;
}

export { createAppUpdateRoutes };
export type { AppUpdater };
