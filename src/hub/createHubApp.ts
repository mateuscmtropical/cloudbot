import { Hono } from 'hono';

import type { InstanceManager, PeopleStore } from './contract.ts';
import { createAdminRoutes } from './admin/createAdminRoutes.ts';

interface CreateHubAppOptions {
    people: PeopleStore;
    instances: InstanceManager;
    domain: string;
    secure: boolean;
}

interface HealthResponse {
    status: 'ok';
}

interface ErrorResponse {
    error: string;
}

const HEALTH_PATH = '/internal/health';
const TLS_ASK_PATH = '/internal/tls-ask';

function normalizeHost(host: string | undefined): string | undefined {
    if (host === undefined) {
        return undefined;
    }

    const match = /^([a-z0-9.-]+)(?::[0-9]{1,5})?$/i.exec(host);

    return match?.[1]?.toLowerCase();
}

function createHubApp(options: CreateHubAppOptions): Hono {
    const app = new Hono();
    const adminRoutes = createAdminRoutes(options);

    app.route('/', adminRoutes);
    app.get(HEALTH_PATH, (context) => {
        const body: HealthResponse = { status: 'ok' };

        return context.json(body);
    });
    app.get(TLS_ASK_PATH, (context) => {
        const requestedDomain = context.req.query('domain');
        const host = normalizeHost(requestedDomain);
        const configuredDomain = options.domain.toLowerCase();
        const isApex = host === configuredDomain;
        const people = options.people.list();
        const isPerson = host !== undefined && people
            .some(record => host === `${record.name}.${configuredDomain}`);

        if (isApex || isPerson) {
            return context.body(null, 200);
        }

        const body: ErrorResponse = { error: 'Host not found.' };

        return context.json(body, 404);
    });
    // Front door auth, proxy and page routes are mounted here by the reviewer.
    app.notFound((context) => {
        const body: ErrorResponse = { error: 'Not found.' };

        return context.json(body, 404);
    });
    app.onError((_error, context) => {
        const body: ErrorResponse = { error: 'The hub could not complete the request.' };

        return context.json(body, 500);
    });

    return app;
}

export { createHubApp };
export type { CreateHubAppOptions };
