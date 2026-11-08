import { Hono } from 'hono';

import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { InstanceUsage, ServerUsage } from '../../shared/usageTypes.ts';
import type { HubConfig } from '../people/hubConfig.ts';

type FetchFunction = typeof fetch;

interface UsageRoutesOptions {
    readOwn: () => Promise<InstanceUsage | undefined>;
    // Only on the owner's instance. The hub refuses everyone else anyway.
    readServer?: (() => Promise<ServerUsage | undefined>) | undefined;
}

const BAD_GATEWAY = 502;
const FAILED_TEXT = 'Could not read the usage from the hub.';

// Asks the hub for numbers with the secret of this instance. A hub that cannot answer gives nothing.
async function fetchHubUsage<Answer>(config: HubConfig, path: string, fetchFunction: FetchFunction = fetch): Promise<Answer | undefined> {
    const headers = { [INSTANCE_NAME_HEADER]: config.personName, [INSTANCE_SECRET_HEADER]: config.secret };
    const response = await fetchFunction(`${config.hubUrl}${path}`, { headers })
        .catch(() => undefined);

    if (response?.ok !== true) {
        return undefined;
    }

    const answer = await response.json()
        .catch(() => undefined) as Answer | undefined;

    return answer;
}

// The resource usage, behind the session check. Every person sees their own instance. The machine and the other
// instances are routes of the owner's instance only.
function createUsageRoutes(options: UsageRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/usage/me', async (context) => {
        const usage = await options.readOwn();

        return usage === undefined ? context.json({ error: FAILED_TEXT }, BAD_GATEWAY) : context.json(usage);
    });

    const readServer = options.readServer;

    if (readServer !== undefined) {
        routes.get('/api/usage', async (context) => {
            const usage = await readServer();

            return usage === undefined ? context.json({ error: FAILED_TEXT }, BAD_GATEWAY) : context.json(usage);
        });
    }

    return routes;
}

export { createUsageRoutes, fetchHubUsage };
export type { UsageRoutesOptions };
