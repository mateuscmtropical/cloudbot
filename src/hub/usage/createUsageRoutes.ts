import { Hono } from 'hono';

import { HUB_MY_USAGE_PATH, HUB_USAGE_PATH } from '../../shared/hubProtocol.ts';
import type { ServerUsage } from '../../shared/usageTypes.ts';
import { authorizeInstance, authorizeOwner } from '../admin/instanceAuth.ts';
import type { PeopleStore } from '../contract.ts';
import type { UsageReader } from './UsageReader.ts';

interface CreateUsageRoutesOptions {
    people: PeopleStore;
    usage: Pick<UsageReader, 'readHost' | 'readInstance'>;
}

const UNAUTHORIZED_MESSAGE = 'Authentication is required.';
const UNAUTHORIZED = 401;

// The machine and every instance go to the owner only. Anyone else gets their own instance, picked by the secret they
// sent and never by a name they give.
function createUsageRoutes(options: CreateUsageRoutesOptions): Hono {
    const app = new Hono();

    app.get(HUB_USAGE_PATH, async (context) => {
        if (authorizeOwner(context, options.people) === undefined) {
            return context.json({ error: UNAUTHORIZED_MESSAGE }, UNAUTHORIZED);
        }

        const records = options.people.list();
        const instanceReads = records.map(record => options.usage.readInstance(record));
        const [host, instances] = await Promise.all([options.usage.readHost(), Promise.all(instanceReads)]);
        const answer: ServerUsage = { host, instances };

        return context.json(answer);
    });
    app.get(HUB_MY_USAGE_PATH, async (context) => {
        const person = authorizeInstance(context, options.people);

        if (person === undefined) {
            return context.json({ error: UNAUTHORIZED_MESSAGE }, UNAUTHORIZED);
        }

        const instance = await options.usage.readInstance(person);

        return context.json(instance);
    });

    return app;
}

export { createUsageRoutes };
export type { CreateUsageRoutesOptions };
