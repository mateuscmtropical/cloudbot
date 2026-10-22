import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Context, MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import { PasskeyError } from './PasskeyService.ts';
import type { PasskeyService } from './PasskeyService.ts';
import { SESSION_COOKIE_NAME } from './requireSession.ts';

interface PasskeyRoutesOptions {
    passkeys: PasskeyService;
    sessionCookieOptions: CookieOptions;
    // The origin check for the public sign-in routes. The /api routes already have it.
    sameOriginCheck: MiddlewareHandler;
}

interface PasskeyRefusal {
    error: string;
}

const FAILED_MESSAGE = 'The passkey could not be checked. Try again.';
// A browser's passkey answer is a few kilobytes. The sign-in routes are public, so a bigger body is refused unread.
const MAX_PASSKEY_BODY_BYTES = 64 * 1024;

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

// A PasskeyError carries a message for the owner. Anything else, such as a malformed response, gets a fixed message.
function refusal(context: Context, error: unknown): Response {
    const message = error instanceof PasskeyError ? error.message : FAILED_MESSAGE;
    const body: PasskeyRefusal = { error: message };

    return context.json(body, 400);
}

// The /api routes sit behind the session check, so only the signed-in owner adds, lists or removes a passkey.
// The /auth routes are public: they are how the owner signs in.
function createPasskeyRoutes(options: PasskeyRoutesOptions): Hono {
    const routes = new Hono();
    const { passkeys } = options;

    routes.post('/api/passkeys/register/options', async (context) => {
        try {
            const creationOptions = await passkeys.registrationOptions();

            return context.json(creationOptions);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.post('/api/passkeys/register/verify', async (context) => {
        const body = await readJson(context);

        if (!isRecord(body) || !isRecord(body.response)) {
            return refusal(context, undefined);
        }

        try {
            const added = await passkeys.verifyRegistration(body.response as unknown as RegistrationResponseJSON, body.name);

            return context.json(added);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.get('/api/passkeys', async (context) => {
        const list = await passkeys.list();

        return context.json(list);
    });

    routes.delete('/api/passkeys/:id', async (context) => {
        const passkeyId = context.req.param('id');
        const isRemoved = await passkeys.remove(passkeyId);

        return isRemoved ? context.body(null, 204) : context.json({ error: 'No passkey has that id.' }, 404);
    });

    routes.use('/auth/passkey/*', options.sameOriginCheck);
    const passkeyBodyLimit = bodyLimit({ maxSize: MAX_PASSKEY_BODY_BYTES, onError: context => context.json({ error: 'The request is too large.' }, 413) });

    routes.use('/auth/passkey/*', passkeyBodyLimit);
    routes.use('/api/passkeys/*', passkeyBodyLimit);

    routes.post('/auth/passkey/options', async (context) => {
        try {
            const requestOptions = await passkeys.loginOptions();

            return context.json(requestOptions);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    routes.post('/auth/passkey/verify', async (context) => {
        const body = await readJson(context);

        if (!isRecord(body)) {
            return refusal(context, undefined);
        }

        try {
            const sessionToken = await passkeys.verifyLogin(body as unknown as AuthenticationResponseJSON);

            setCookie(context, SESSION_COOKIE_NAME, sessionToken, options.sessionCookieOptions);

            return context.body(null, 204);
        } catch (error: unknown) {
            return refusal(context, error);
        }
    });

    return routes;
}

export { createPasskeyRoutes };
export type { PasskeyRoutesOptions };
