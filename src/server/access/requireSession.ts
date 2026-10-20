import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

import type { SetupAccess } from './SetupAccess.ts';

const SESSION_COOKIE_NAME = 'cloudbot_session';

interface AccessErrorResponse {
    error: string;
}

function requireSession(access: SetupAccess): MiddlewareHandler {
    return async (context, next) => {
        const sessionToken = getCookie(context, SESSION_COOKIE_NAME);
        const isSessionValid = await access.isValidSession(sessionToken);

        if (!isSessionValid) {
            const body: AccessErrorResponse = { error: 'Open the setup link printed by the server to sign in.' };

            return context.json(body, 401);
        }

        await next();
    };
}

export { requireSession, SESSION_COOKIE_NAME };
export type { AccessErrorResponse };
