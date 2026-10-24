import { describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { GOOGLE_CLIENT_SECRET_NAME, GOOGLE_SITE, GoogleClientStore } from './googleClient.ts';
import { createGoogleClientRoutes } from './createGoogleClientRoutes.ts';
import { isOAuthSecretName } from './AppOAuthTokens.ts';

const REDIRECT_URI = 'https://bot.example.com/api/apps/oauth/callback';
const CLIENT_ID = '123456-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-very-secret-value';
const PATH = '/api/apps/google/client';

function setup(): { routes: ReturnType<typeof createGoogleClientRoutes>; store: GoogleClientStore; saved: Map<string, BotSecret> } {
    const saved = new Map<string, BotSecret>();
    const store = new GoogleClientStore({
        read: (botId, name) => saved.get(`${botId}:${name}`),
        save: (botId, name, site, value) => {
            saved.set(`${botId}:${name}`, { site, value });
        },
        remove: (botId, name) => {
            saved.delete(`${botId}:${name}`);
        },
    });
    const routes = createGoogleClientRoutes({ client: store, redirectUri: REDIRECT_URI, hasBot: botId => Promise.resolve(botId === 'bot-1') });

    return { routes, store, saved };
}

async function put(routes: ReturnType<typeof createGoogleClientRoutes>, value: unknown): Promise<Response> {
    return routes.request(PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

describe('Google client routes', () => {
    it('keeps the secret under a name the bot can never type into a page', () => {
        expect(isOAuthSecretName(GOOGLE_CLIENT_SECRET_NAME))
            .toBe(true);
        expect(GOOGLE_CLIENT_SECRET_NAME)
            .toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    });

    it('says no client is saved yet, and gives the redirect address', async () => {
        const { routes } = setup();
        const response = await routes.request(`${PATH}?bot=bot-1`);

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ configured: false, redirectUri: REDIRECT_URI });
    });

    it('saves the client in the vault for the Google site and answers without the secret', async () => {
        const { routes, store, saved } = setup();
        const response = await put(routes, { botId: 'bot-1', clientId: ` ${CLIENT_ID} `, clientSecret: ` ${CLIENT_SECRET} ` });
        const text = await response.text();

        expect(response.status)
            .toBe(200);
        expect(JSON.parse(text))
            .toEqual({ configured: true, redirectUri: REDIRECT_URI });
        expect(text)
            .not.toContain(CLIENT_SECRET);
        expect(store.read('bot-1'))
            .toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
        expect(saved.get(`bot-1:${GOOGLE_CLIENT_SECRET_NAME}`)?.site)
            .toBe(GOOGLE_SITE);

        const status = await routes.request(`${PATH}?bot=bot-1`);

        expect(await status.text())
            .not.toContain(CLIENT_SECRET);
    });

    it('refuses a client id that is not a Google one, an empty or short secret and a missing bot', async () => {
        const { routes, saved } = setup();
        const badId = await put(routes, { botId: 'bot-1', clientId: 'my-client', clientSecret: CLIENT_SECRET });
        const emptyId = await put(routes, { botId: 'bot-1', clientId: '  ', clientSecret: CLIENT_SECRET });
        const shortSecret = await put(routes, { botId: 'bot-1', clientId: CLIENT_ID, clientSecret: 'short' });
        const spacedSecret = await put(routes, { botId: 'bot-1', clientId: CLIENT_ID, clientSecret: 'has some spaces inside' });
        const longSecret = await put(routes, { botId: 'bot-1', clientId: CLIENT_ID, clientSecret: 'x'.repeat(257) });
        const notText = await put(routes, { botId: 'bot-1', clientId: 5, clientSecret: CLIENT_SECRET });
        const noBotId = await put(routes, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
        const notJson = await routes.request(PATH, { method: 'PUT', body: 'nope' });

        expect([badId.status, emptyId.status, shortSecret.status, spacedSecret.status, longSecret.status, notText.status, noBotId.status, notJson.status])
            .toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
        expect(saved.size)
            .toBe(0);
    });

    it('answers 404 for a bot that does not exist, and saves nothing', async () => {
        const { routes, saved } = setup();
        const getResponse = await routes.request(`${PATH}?bot=other`);
        const putResponse = await put(routes, { botId: 'other', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
        const deleteResponse = await routes.request(`${PATH}?bot=other`, { method: 'DELETE' });

        expect([getResponse.status, putResponse.status, deleteResponse.status])
            .toEqual([404, 404, 404]);
        expect(saved.size)
            .toBe(0);
    });

    it('needs a bot id to read or forget the client', async () => {
        const { routes } = setup();
        const getResponse = await routes.request(PATH);
        const deleteResponse = await routes.request(PATH, { method: 'DELETE' });

        expect([getResponse.status, deleteResponse.status])
            .toEqual([400, 400]);
    });

    it('forgets the client', async () => {
        const { routes, store } = setup();

        await put(routes, { botId: 'bot-1', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
        const response = await routes.request(`${PATH}?bot=bot-1`, { method: 'DELETE' });

        expect(response.status)
            .toBe(204);
        expect(store.read('bot-1'))
            .toBeUndefined();
    });

    it('ignores a saved value that is not a client, or is for another site', () => {
        const saved = new Map<string, BotSecret>();
        const store = new GoogleClientStore({
            read: (_botId, name) => saved.get(name),
            save: () => undefined,
            remove: () => undefined,
        });

        saved.set(GOOGLE_CLIENT_SECRET_NAME, { site: GOOGLE_SITE, value: 'not json' });
        expect(store.read('bot-1'))
            .toBeUndefined();

        saved.set(GOOGLE_CLIENT_SECRET_NAME, { site: 'https://evil.example.com', value: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }) });
        expect(store.read('bot-1'))
            .toBeUndefined();
    });
});
