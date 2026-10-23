import { Hono } from 'hono';

import { HUB_ACTIVITY_PATH } from '../../shared/hubProtocol.ts';
import { computeActivity } from './activity.ts';
import type { ActivitySources } from './activity.ts';

interface HubActivityRouteOptions {
    readSources: () => Promise<ActivitySources>;
}

function createHubActivityRoutes(options: HubActivityRouteOptions): Hono {
    const routes = new Hono();

    routes.get(HUB_ACTIVITY_PATH, async (context) => {
        const sources = await options.readSources();
        const activity = computeActivity(sources);

        return context.json(activity);
    });

    return routes;
}

export { createHubActivityRoutes };
export type { HubActivityRouteOptions };
