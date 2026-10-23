import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';
import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { HubPasskeyError } from './HubPasskeyService.ts';
import type { HubPasskeyService } from './HubPasskeyService.ts';
import { renderOfferPage, renderPasskeysPage } from './passkeyPage.ts';

interface HubPasskeyPageInput {
    title: string;
    body: string;
    scripts: string[];
}

interface HubPasskeyRenderedPage {
    html: string;
    csp: string;
}

interface HubPasskeyRoutesOptions {
    passkeys: HubPasskeyService;
    requireSession: MiddlewareHandler;
    sameOriginCheck: MiddlewareHandler;
    requestPersonName: (context: Context) => string | undefined;
    sessionPersonName: (context: Context) => string | undefined;
    startSession: (name: string, response: Context) => void | Promise<void>;
    renderPage: (page: HubPasskeyPageInput) => HubPasskeyRenderedPage;
}

interface ErrorResponse {
    error: string;
}

interface RegistrationBody {
    response: RegistrationResponseJSON;
    label?: unknown;
}

const FAILED_MESSAGE = 'The passkey could not be checked. Try again.';
const MAX_PASSKEY_BODY_BYTES = 64 * 1024;
const PASSKEY_BODY_LIMIT = bodyLimit({
    maxSize: MAX_PASSKEY_BODY_BYTES,
    onError: context => context.json({ error: 'The request is too large.' }, 413),
});

async function readJson(context: Context): Promise<unknown> {
    try {
        return await context.req.json();
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refusal(context: Context, error: unknown): Response {
    const message = error instanceof HubPasskeyError ? error.message : FAILED_MESSAGE;
    const body: ErrorResponse = { error: message };

    return context.json(body, 400);
}

function signedInPersonName(context: Context, options: HubPasskeyRoutesOptions): string | undefined {
    const requestName = options.requestPersonName(context);
    const sessionName = options.sessionPersonName(context);

    return requestName !== undefined && requestName === sessionName ? sessionName : undefined;
}

function htmlPage(context: Context, options: HubPasskeyRoutesOptions, input: HubPasskeyPageInput): Response {
    const page = options.renderPage(input);

    return context.html(page.html, { headers: { 'Content-Security-Policy': page.csp } });
}

function createHubPasskeyRoutes(options: HubPasskeyRoutesOptions): Hono {
    const routes = new Hono();
    const { passkeys } = options;

    routes.use('/__hub/passkey/register/*', options.sameOriginCheck);
    routes.use('/__hub/passkey/login/*', options.sameOriginCheck);
    routes.use('/__hub/passkey/:id', options.sameOriginCheck);
    routes.use('/__hub/passkey/register/*', options.requireSession);
    routes.use('/__hub/passkey/list', options.requireSession);
    routes.use('/__hub/passkey/:id', options.requireSession);
    routes.use('/__hub/passkey/offer', options.requireSession);
    routes.use('/__hub/passkeys', options.requireSession);
    routes.use('/__hub/passkey/register/*', PASSKEY_BODY_LIMIT);
    routes.use('/__hub/passkey/login/*', PASSKEY_BODY_LIMIT);

    routes.post('/__hub/passkey/register/options', async (context) => {
        const personName = signedInPersonName(context, options);

        if (personName === undefined) {
            return context.json({ error: 'Sign in at your own address to manage passkeys.' }, 403);
        }

        try {
            const creationOptions = await passkeys.registrationOptions(personName, context.req.url);

            return context.json(creationOptions);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.post('/__hub/passkey/register/verify', async (context) => {
        const personName = signedInPersonName(context, options);
        const body = await readJson(context);

        if (personName === undefined) {
            return context.json({ error: 'Sign in at your own address to manage passkeys.' }, 403);
        }

        if (!isRecord(body) || !isRecord(body.response)) {
            return refusal(context, undefined);
        }

        const registrationBody: RegistrationBody = {
            response: body.response as unknown as RegistrationResponseJSON,
            label: body.label,
        };

        try {
            const added = await passkeys.verifyRegistration(registrationBody.response, personName, context.req.url, registrationBody.label);

            return context.json(added);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.post('/__hub/passkey/login/options', async (context) => {
        const personName = options.requestPersonName(context);

        if (personName === undefined) {
            return context.json({ error: 'No person is assigned to this address.' }, 404);
        }

        try {
            const requestOptions = await passkeys.loginOptions(personName, context.req.url);

            return context.json(requestOptions);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.post('/__hub/passkey/login/verify', async (context) => {
        const personName = options.requestPersonName(context);
        const body = await readJson(context);

        if (personName === undefined) {
            return context.json({ error: 'No person is assigned to this address.' }, 404);
        }

        if (!isRecord(body)) {
            return refusal(context, undefined);
        }

        try {
            const signedInName = await passkeys.verifyLogin(body as unknown as AuthenticationResponseJSON, personName, context.req.url);

            await options.startSession(signedInName, context);

            return context.body(null, 204);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.get('/__hub/passkey/list', (context) => {
        const personName = signedInPersonName(context, options);

        if (personName === undefined) {
            return context.json({ error: 'Sign in at your own address to manage passkeys.' }, 403);
        }

        const summaries = passkeys.list(personName);

        return context.json(summaries);
    });

    routes.delete('/__hub/passkey/:id', (context) => {
        const personName = signedInPersonName(context, options);

        if (personName === undefined) {
            return context.json({ error: 'Sign in at your own address to manage passkeys.' }, 403);
        }

        const credentialId = context.req.param('id');
        const wasRemoved = passkeys.remove(personName, credentialId);

        return wasRemoved ? context.body(null, 204) : context.json({ error: 'No passkey has that id.' }, 404);
    });

    routes.get('/__hub/passkey/offer', (context) => {
        const personName = signedInPersonName(context, options);

        if (personName === undefined) {
            return context.text('Not found', 404);
        }

        const offer = renderOfferPage();
        const input: HubPasskeyPageInput = { title: 'Turn on fingerprint or face?', body: offer.body, scripts: [offer.script] };

        return htmlPage(context, options, input);
    });

    routes.get('/__hub/passkeys', (context) => {
        const personName = signedInPersonName(context, options);

        if (personName === undefined) {
            return context.text('Not found', 404);
        }

        const summaries = passkeys.list(personName);
        const page = renderPasskeysPage(summaries);
        const input: HubPasskeyPageInput = { title: 'Your passkeys', body: page.body, scripts: [page.script] };

        return htmlPage(context, options, input);
    });

    return routes;
}

export { createHubPasskeyRoutes };
export type { HubPasskeyPageInput, HubPasskeyRenderedPage, HubPasskeyRoutesOptions };
