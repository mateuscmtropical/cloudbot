import { describe, expect, it } from 'vitest';

import type { AppSignInFinish, AppSignInReturn } from './AppOAuth.ts';
import { createAppOAuthCallbackRoutes } from './createAppOAuthCallbackRoutes.ts';
import { createAppRoutes } from './createAppRoutes.ts';

function callbackRoutes(result: AppSignInFinish, seen: AppSignInReturn[]): ReturnType<typeof createAppOAuthCallbackRoutes> {
    return createAppOAuthCallbackRoutes({
        oauth: {
            finish: (request) => {
                seen.push(request);

                return Promise.resolve(result);
            },
        },
    });
}

describe('app sign-in callback', () => {
    it('passes what the server sent, and moves on to the app with a page, not a redirect', async () => {
        const seen: AppSignInReturn[] = [];
        const routes = callbackRoutes({ outcome: 'connected', botId: 'bot-1', appName: 'notion' }, seen);

        const response = await routes.request('/api/apps/oauth/callback?state=s1&code=c1&iss=https%3A%2F%2Fauth.example.com');
        const page = await response.text();

        expect(response.status)
            .toBe(200);
        expect(response.headers.get('cache-control'))
            .toBe('no-store');
        expect(seen)
            .toEqual([{ state: 's1', code: 'c1', error: undefined, issuer: 'https://auth.example.com' }]);
        expect(page)
            .toContain('http-equiv="refresh" content="0;url=/?apps=connected&amp;app=notion&amp;bot=bot-1"');
    });

    it('reports a failure without naming an app when the sign-in was not found', async () => {
        const routes = callbackRoutes({ outcome: 'failed', botId: undefined, appName: undefined }, []);

        const response = await routes.request('/api/apps/oauth/callback?state=nope&error=access_denied');
        const page = await response.text();

        expect(page)
            .toContain('url=/?apps=failed"');
    });
});

describe('app sign-in start', () => {
    function startRoutes(start: () => Promise<{ status: 'unsupported' }>, hasBot: boolean): ReturnType<typeof createAppRoutes> {
        return createAppRoutes({
            connectedApps: { list: () => Promise.resolve([]), remove: () => Promise.resolve(false) },
            signIn: { oauth: { start }, redirectUri: 'https://bot.example.com/api/apps/oauth/callback', hasBot: () => Promise.resolve(hasBot) },
        });
    }

    async function post(routes: ReturnType<typeof createAppRoutes>, body: unknown): Promise<Response> {
        return routes.request('/api/apps/oauth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }

    it('answers with what the sign-in found', async () => {
        const routes = startRoutes(() => Promise.resolve({ status: 'unsupported' }), true);

        const response = await post(routes, { botId: 'bot-1', name: 'notion', url: 'https://mcp.notion.com/mcp' });

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ status: 'unsupported' });
    });

    it('refuses a bad request, and a bot that does not exist', async () => {
        const routes = startRoutes(() => Promise.resolve({ status: 'unsupported' }), false);

        expect((await post(routes, { botId: 'bot-1', name: 'Bad Name', url: 'https://mcp.notion.com/mcp' })).status)
            .toBe(400);
        expect((await post(routes, { botId: 'bot-1', name: 'notion', url: 'https://mcp.notion.com/mcp?token=x' })).status)
            .toBe(400);
        expect((await post(routes, { botId: 'bot-1', name: 'notion', url: 'https://mcp.notion.com/mcp' })).status)
            .toBe(404);
    });
});
