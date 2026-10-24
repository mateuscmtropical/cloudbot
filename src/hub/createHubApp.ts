import { Hono } from 'hono';
import type { BlockList } from 'node:net';

import type { ActivityTracker, InstanceManager, PeopleStore } from './contract.ts';
import { createAdminRoutes } from './admin/createAdminRoutes.ts';
import { createFrontDoorRoutes } from './auth/createFrontDoorRoutes.ts';
import type { OwnerSetupOptions } from './auth/createFrontDoorRoutes.ts';
import type { LoginSessions } from './auth/LoginSessions.ts';
import { readHostRoute } from './auth/hostRouting.ts';
import { readContextCookie, readHubSession, readRequestHost, renderUnavailable, requestHasSameOrigin, startHubSession } from './auth/routeHelpers.ts';
import { createAfterLogin, PASSKEY_OFFER_COOKIE, passkeyLoginExtras } from './passkeys/passkeyPage.ts';
import { createHubPasskeyRoutes } from './passkeys/createHubPasskeyRoutes.ts';
import type { HubPasskeyService } from './passkeys/HubPasskeyService.ts';
import type { HubPasskeyStore } from './passkeys/HubPasskeyStore.ts';
import { renderPage } from './pages/renderPage.ts';

interface CreateHubAppOptions {
    people: PeopleStore;
    instances: InstanceManager;
    sessions: LoginSessions;
    passkeys: HubPasskeyService;
    passkeyStore: HubPasskeyStore;
    domain: string;
    secure: boolean;
    loginAllowedIps?: BlockList;
    ownerSetup?: OwnerSetupOptions;
    activity: ActivityTracker;
    hubPort?: number;
    now?: () => number;
    upstreamFor?: (name: string) => { hostname: string; port: number };
}

interface HealthResponse {
    status: 'ok';
}

interface ErrorResponse {
    error: string;
}

const HEALTH_PATH = '/internal/health';
const TLS_ASK_PATH = '/internal/tls-ask';
const INTERNAL_SERVICE_PORT = 3001;

function normalizeHost(host: string | undefined): string | undefined {
    if (host === undefined) {
        return undefined;
    }

    const match = /^([a-z0-9.-]+)(?::[0-9]{1,5})?$/i.exec(host);

    return match?.[1]?.toLowerCase();
}

function isInternalHost(host: string | undefined, hubPort: number): boolean {
    if (host === undefined) {
        return false;
    }

    const normalizedHost = host.toLowerCase();

    return normalizedHost === `hub:${String(INTERNAL_SERVICE_PORT)}`
        || normalizedHost === `127.0.0.1:${String(hubPort)}`
        || normalizedHost === `localhost:${String(hubPort)}`;
}

function createHubApp(options: CreateHubAppOptions): Hono {
    const app = new Hono();
    const hubPort = options.hubPort ?? INTERNAL_SERVICE_PORT;
    const adminRoutes = createAdminRoutes(options);
    const passkeyRoutes = createHubPasskeyRoutes({
        passkeys: options.passkeys,
        ...(options.loginAllowedIps === undefined ? {} : { loginAllowedIps: options.loginAllowedIps }),
        requireSession: async (context, next) => {
            const requestHost = readRequestHost(context);
            const requestName = readHostRoute(requestHost, options.domain)?.name;
            const currentTime = options.now?.() ?? Date.now();
            const session = readHubSession(context, options.sessions, currentTime);

            if (session === undefined) {
                return context.json({ error: 'Sign in first.' }, 401);
            }

            const person = requestName === undefined ? undefined : options.people.find(requestName);

            if (person === undefined || person.state !== 'active') {
                return renderUnavailable(context);
            }

            await next();
        },
        sameOriginCheck: async (context, next) => {
            if (context.req.method !== 'POST' && context.req.method !== 'DELETE') {
                await next();

                return;
            }

            if (!requestHasSameOrigin(context, options.secure)) {
                return context.text('This request did not come from this page.', 403);
            }

            await next();
        },
        requestPersonName: (context) => {
            const requestHost = readRequestHost(context);

            return readHostRoute(requestHost, options.domain)?.name;
        },
        sessionPersonName: (context) => {
            const currentTime = options.now?.() ?? Date.now();

            return readHubSession(context, options.sessions, currentTime)?.name;
        },
        isPersonActive: name => options.people.find(name)?.state === 'active',
        startSession: (name, context) => {
            const person = options.people.find(name);

            if (person === undefined || person.state !== 'active') {
                return false;
            }

            const currentTime = options.now?.() ?? Date.now();

            startHubSession(context, options.sessions, name, options.secure, currentTime);
            options.people.update(name, { lastSeenAt: currentTime });

            return true;
        },
        renderPage: page => renderPage(page),
    });
    const frontDoor = createFrontDoorRoutes({
        people: options.people,
        instances: options.instances,
        sessions: options.sessions,
        domain: options.domain,
        secure: options.secure,
        activity: options.activity,
        ...(options.loginAllowedIps === undefined ? {} : { loginAllowedIps: options.loginAllowedIps }),
        ...(options.ownerSetup === undefined ? {} : { ownerSetup: options.ownerSetup }),
        loginExtras: passkeyLoginExtras(),
        afterLogin: createAfterLogin({
            store: options.passkeyStore,
            cookiesOf: (_name, context) => readContextCookie(context, PASSKEY_OFFER_COOKIE),
        }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.upstreamFor === undefined ? {} : { upstreamFor: options.upstreamFor }),
    });

    // This runs before every internal endpoint so the public Host forwarded by Caddy cannot reach admin or health routes.
    app.use('*', async (context, next) => {
        if (context.req.path === '/internal' || context.req.path.startsWith('/internal/')) {
            const requestHost = context.req.header('host');

            if (!isInternalHost(requestHost, hubPort)) {
                const body: ErrorResponse = { error: 'Not found.' };

                return context.json(body, 404);
            }
        }

        await next();
    });

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

        const hasOwner = people.some(record => record.role === 'owner');
        const isPendingOwner = options.ownerSetup !== undefined && !hasOwner && host === `${options.ownerSetup.ownerName}.${configuredDomain}`;

        if (isApex || isPerson || isPendingOwner) {
            return context.body(null, 200);
        }

        const body: ErrorResponse = { error: 'Host not found.' };

        return context.json(body, 404);
    });
    app.route('/', adminRoutes);
    app.route('/', passkeyRoutes);
    app.route('/', frontDoor);
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
