import { Hono } from 'hono';

import { HUB_MY_GROUPS_PATH, INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../../shared/hubProtocol.ts';
import type { MyGroup } from '../../shared/peopleTypes.ts';
import type { HubConfig } from './hubConfig.ts';

type FetchFunction = typeof fetch;

// Asks the hub which shared groups this person is in. A hub that cannot answer gives no groups.
async function fetchMyGroups(config: HubConfig, fetchFunction: FetchFunction = fetch): Promise<MyGroup[]> {
    const headers = { [INSTANCE_NAME_HEADER]: config.personName, [INSTANCE_SECRET_HEADER]: config.secret };
    const response = await fetchFunction(`${config.hubUrl}${HUB_MY_GROUPS_PATH}`, { headers })
        .catch(() => undefined);
    const answer: unknown = response?.ok === true
        ? await response.json()
                .catch(() => undefined)
        : undefined;

    return Array.isArray(answer) ? answer as MyGroup[] : [];
}

// Each person sees the shared groups they are in, and opens one through the hub on their own address.
function createMyGroupsRoute(listMyGroups: () => Promise<MyGroup[]>): Hono {
    const routes = new Hono();

    routes.get('/api/my-groups', async (context) => {
        const groups = await listMyGroups();

        return context.json(groups);
    });

    return routes;
}

export { createMyGroupsRoute, fetchMyGroups };
