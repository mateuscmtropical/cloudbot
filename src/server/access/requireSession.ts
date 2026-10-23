import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

import { HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { isValidHubSecret } from './hubSession.ts';
import type { SetupAccess } from './SetupAccess.ts';

const SESSION_COOKIE_NAME = 'cloudbot_session';

interface AccessErrorResponse {
    error: string;
}

function requireSession(access: SetupAccess, hubSecret?: string): MiddlewareHandler {
    return async (context, next) => {
        const presentedHubSecret = context.req.header(HUB_TRUST_HEADER);
        const isHubSession = isValidHubSecret(presentedHubSecret, hubSecret);

        if (isHubSession) {
            await next();

            return;
        }

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
