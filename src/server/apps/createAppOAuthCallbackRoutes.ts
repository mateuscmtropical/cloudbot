import { Hono } from 'hono';

import { APP_OAUTH_CALLBACK_PATH } from '../../shared/connectedApps.ts';
import type { AppOAuth } from './AppOAuth.ts';

interface AppOAuthCallbackOptions {
    oauth: Pick<AppOAuth, 'finish'>;
}

// The page of the server sends the owner here with a code. The route sits outside the session check, because the
// browser comes from another site and does not send its strict cookie. The state of the sign-in is what ties this
// request to the owner who started it, and it works once.
// The answer is a page that moves on to the app by itself, since a redirect from another site would also drop the cookie.
function escapeAttribute(value: string): string {
    return value.replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;');
}

function renderReturnPage(address: string): string {
    const safeAddress = escapeAttribute(address);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="0;url=${safeAddress}">
<title>CloudBot</title>
</head>
<body>
<p>Going back to CloudBot...</p>
<p><a href="${safeAddress}">Continue</a></p>
</body>
</html>
`;
}

function createAppOAuthCallbackRoutes(options: AppOAuthCallbackOptions): Hono {
    const routes = new Hono();

    routes.get(APP_OAUTH_CALLBACK_PATH, async (context) => {
        const finish = await options.oauth.finish({
            state: context.req.query('state'),
            code: context.req.query('code'),
            error: context.req.query('error'),
            issuer: context.req.query('iss'),
        });
        const returnParams = new URLSearchParams({ apps: finish.outcome });

        if (finish.appName !== undefined) {
            returnParams.set('app', finish.appName);
        }

        if (finish.botId !== undefined) {
            returnParams.set('bot', finish.botId);
        }

        const page = renderReturnPage(`/?${returnParams.toString()}`);

        context.header('cache-control', 'no-store');

        return context.html(page);
    });

    return routes;
}

export { createAppOAuthCallbackRoutes };
export type { AppOAuthCallbackOptions };
