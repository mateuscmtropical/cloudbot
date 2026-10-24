import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { ConnectedAppStore } from '../store/ConnectedAppStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { AppOAuth } from './AppOAuth.ts';
import { AppOAuthTokens, oauthSecretName } from './AppOAuthTokens.ts';
import { AppProxy } from './AppProxy.ts';
import { ConnectedApps } from './ConnectedApps.ts';
import type { FetchFunction } from './probeAppServer.ts';

const BOT_ID = 'bot-1';
const SERVER_URL = 'https://mcp.example.com/mcp';
const REDIRECT_URI = 'https://bot.example.com/api/apps/oauth/callback';
const AUTH_ORIGIN = 'https://auth.example.com';
const PUBLIC_ADDRESS = '93.184.216.34';

interface FakeWorld {
    fetch: FetchFunction;
    requests: { url: string; body: string }[];
    options: { registration: boolean; tokenStatus: number; withMetadata: boolean; resource: string; issuer: string };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// A server with its own sign-in page, and the authorization server it names. The server answers only with the access token it granted.
function fakeWorld(): FakeWorld {
    const requests: { url: string; body: string }[] = [];
    const options = { registration: true, tokenStatus: 200, withMetadata: true, resource: 'https://mcp.example.com', issuer: AUTH_ORIGIN };
    const respond = (url: string, init: RequestInit): Response => {
        const body = typeof init.body === 'string' ? init.body : '';

        requests.push({ url, body });

        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
            return options.withMetadata
                ? jsonResponse({ resource: options.resource, authorization_servers: [AUTH_ORIGIN], scopes_supported: ['read', 'write'] })
                : new Response('no', { status: 404 });
        }

        if (url === `${AUTH_ORIGIN}/.well-known/oauth-authorization-server`) {
            return jsonResponse({
                issuer: options.issuer,
                authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
                token_endpoint: `${AUTH_ORIGIN}/token`,
                registration_endpoint: options.registration ? `${AUTH_ORIGIN}/register` : undefined,
                code_challenge_methods_supported: ['S256'],
            });
        }

        if (url === `${AUTH_ORIGIN}/register`) {
            return jsonResponse({ client_id: 'client-1' }, 201);
        }

        if (url === `${AUTH_ORIGIN}/token`) {
            return options.tokenStatus === 200
                ? jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
                : new Response('no', { status: options.tokenStatus });
        }

        const headers = init.headers as Record<string, string>;

        if (headers['authorization'] !== 'Bearer at-1') {
            return new Response('no', { status: 401 });
        }

        const parsed = JSON.parse(body) as Record<string, unknown>;

        if (parsed['method'] === 'initialize') {
            return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
        }

        if (parsed['method'] === 'tools/list') {
            return jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }] } });
        }

        return new Response(null, { status: 202 });
    };

    return { fetch: (url, init) => Promise.resolve(respond(url, init)), requests, options };
}

function memorySecrets(): { read: (botId: string, name: string) => BotSecret | undefined; save: (botId: string, name: string, site: string, value: string) => void; remove: (botId: string, name: string) => void } {
    const secrets = new Map<string, BotSecret>();

    return {
        read: (botId, name) => secrets.get(`${botId}:${name}`),
        save: (botId, name, site, value) => {
            secrets.set(`${botId}:${name}`, { site, value });
        },
        remove: (botId, name) => {
            secrets.delete(`${botId}:${name}`);
        },
    };
}

describe('AppOAuth', () => {
    let opened: OpenedDatabase;
    let proxy: AppProxy;
    let store: ConnectedAppStore;
    let world: FakeWorld;
    let secrets: ReturnType<typeof memorySecrets>;
    let oauth: AppOAuth;
    let apps: ConnectedApps;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        proxy = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });
        await proxy.start();
        store = new ConnectedAppStore(opened.db, { now: () => 1000 });
        world = fakeWorld();
        secrets = memorySecrets();

        const tokens = new AppOAuthTokens({ secrets, fetchFunction: world.fetch });

        apps = new ConnectedApps({
            store,
            secrets,
            proxy,
            allowedHosts: () => Promise.resolve([]),
            addressDeps: allowedHosts => ({ resolve: () => Promise.resolve([PUBLIC_ADDRESS]), localAddresses: [], allowedHosts }),
            fetchFunction: world.fetch,
            oauthTokens: tokens,
        });

        oauth = new AppOAuth({ connectedApps: apps, tokens, fetchFunction: world.fetch });
    });

    afterEach(async () => {
        await proxy.close();
        opened.close();
    });

    async function startSignIn(): Promise<{ state: string; authorizationUrl: URL }> {
        const start = await oauth.start(BOT_ID, 'linear', SERVER_URL, REDIRECT_URI);

        if (start.status !== 'redirect') {
            throw new Error(`Expected a redirect, got ${start.status}`);
        }

        const authorizationUrl = new URL(start.authorizationUrl);

        return { state: authorizationUrl.searchParams.get('state') ?? '', authorizationUrl };
    }

    it('sends the owner to the authorization page with a code challenge, the redirect address and the scopes', async () => {
        const { authorizationUrl } = await startSignIn();

        expect(authorizationUrl.origin + authorizationUrl.pathname)
            .toBe(`${AUTH_ORIGIN}/authorize`);
        expect(authorizationUrl.searchParams.get('client_id'))
            .toBe('client-1');
        expect(authorizationUrl.searchParams.get('redirect_uri'))
            .toBe(REDIRECT_URI);
        expect(authorizationUrl.searchParams.get('code_challenge_method'))
            .toBe('S256');
        expect(authorizationUrl.searchParams.get('code_challenge'))
            .not.toBe('');
        expect(authorizationUrl.searchParams.get('scope'))
            .toBe('read write');
        expect(authorizationUrl.searchParams.get('resource'))
            .toBe(SERVER_URL);
        expect(authorizationUrl.searchParams.get('response_type'))
            .toBe('code');
    });

    it('connects the server when the owner comes back with a code, and keeps the token in the vault only', async () => {
        const { state } = await startSignIn();

        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: AUTH_ORIGIN });

        expect(finished)
            .toEqual({ outcome: 'connected', botId: BOT_ID, appName: 'linear' });

        const tokenRequest = world.requests.find(request => request.url === `${AUTH_ORIGIN}/token`);
        const form = new URLSearchParams(tokenRequest?.body ?? '');

        expect(form.get('grant_type'))
            .toBe('authorization_code');
        expect(form.get('code'))
            .toBe('code-1');
        expect(form.get('code_verifier'))
            .not.toBe('');
        expect(form.get('redirect_uri'))
            .toBe(REDIRECT_URI);

        const records = await store.list();

        expect(records[0]?.status)
            .toBe('connected');
        expect(records[0]?.toolCount)
            .toBe(2);
        expect(JSON.stringify(records))
            .not.toContain('at-1');
        expect(secrets.read(BOT_ID, oauthSecretName('linear'))?.site)
            .toBe('https://mcp.example.com');
    });

    it('uses a state once, so a repeated or invented state does nothing', async () => {
        const { state } = await startSignIn();

        await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });

        const repeated = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });
        const invented = await oauth.finish({ state: 'made-up', code: 'code-1', error: undefined, issuer: undefined });

        expect(repeated)
            .toEqual({ outcome: 'failed', botId: undefined, appName: undefined });
        expect(invented)
            .toEqual({ outcome: 'failed', botId: undefined, appName: undefined });
    });

    it('fails when the owner declines, and does not ask for a token', async () => {
        const { state } = await startSignIn();

        const finished = await oauth.finish({ state, code: undefined, error: 'access_denied', issuer: undefined });

        expect(finished)
            .toEqual({ outcome: 'failed', botId: BOT_ID, appName: 'linear' });
        expect(world.requests.some(request => request.url === `${AUTH_ORIGIN}/token`))
            .toBe(false);
    });

    it('fails when the issuer in the answer is not the authorization server', async () => {
        const { state } = await startSignIn();

        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: 'https://evil.example.com' });

        expect(finished.outcome)
            .toBe('failed');
        expect(world.requests.some(request => request.url === `${AUTH_ORIGIN}/token`))
            .toBe(false);
    });

    it('fails when the token endpoint refuses the code', async () => {
        const { state } = await startSignIn();

        world.options.tokenStatus = 400;

        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });

        expect(finished.outcome)
            .toBe('failed');
        expect(secrets.read(BOT_ID, oauthSecretName('linear')))
            .toBeUndefined();
    });

    it('marks the app as needing a sign-in again when the server refuses to renew it', async () => {
        const { state } = await startSignIn();

        await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });

        const secretName = oauthSecretName('linear');
        const secret = secrets.read(BOT_ID, secretName);
        const stored = JSON.parse(secret?.value ?? '{}') as Record<string, unknown>;

        secrets.save(BOT_ID, secretName, secret?.site ?? '', JSON.stringify({ ...stored, expiresAt: 1 }));
        world.options.tokenStatus = 400;

        const configs = await apps.serverConfigs();
        const address = configs['linear'];
        const response = await fetch(address?.type === 'http' ? address.url : '', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

        expect(response.status)
            .toBe(502);
        expect((await store.list())[0]?.status)
            .toBe('needs_token');
        expect(secrets.read(BOT_ID, secretName))
            .toBeUndefined();
    });

    it('says a server without a sign-in page is unsupported, so the chat flow takes over', async () => {
        world.options.withMetadata = false;

        const start = await oauth.start(BOT_ID, 'linear', SERVER_URL, REDIRECT_URI);

        expect(start)
            .toEqual({ status: 'unsupported' });
    });

    it('says a server that names another origin as itself is unsupported', async () => {
        world.options.resource = 'https://evil.example.com';

        expect(await oauth.start(BOT_ID, 'linear', SERVER_URL, REDIRECT_URI))
            .toEqual({ status: 'unsupported' });
    });

    it('says an authorization server that names another issuer is unsupported', async () => {
        world.options.issuer = 'https://evil.example.com';

        expect(await oauth.start(BOT_ID, 'linear', SERVER_URL, REDIRECT_URI))
            .toEqual({ status: 'unsupported' });
    });

    it('says a plain http server is unsupported, since a token goes only to https', async () => {
        expect(await oauth.start(BOT_ID, 'linear', 'http://mcp.example.com/mcp', REDIRECT_URI))
            .toEqual({ status: 'unsupported' });
    });

    it('knows when a sign-in waits for the owner, and when it was used', async () => {
        expect(oauth.hasPending())
            .toBe(false);

        const { state } = await startSignIn();

        expect(oauth.hasPending())
            .toBe(true);

        await oauth.finish({ state, code: undefined, error: 'access_denied', issuer: undefined });

        expect(oauth.hasPending())
            .toBe(false);
    });

    it('says a server that cannot register apps is unsupported', async () => {
        world.options.registration = false;

        const start = await oauth.start(BOT_ID, 'linear', SERVER_URL, REDIRECT_URI);

        expect(start)
            .toEqual({ status: 'unsupported' });
    });

    it('refuses an address with a token in it without any request', async () => {
        const start = await oauth.start(BOT_ID, 'linear', `${SERVER_URL}?token=abc`, REDIRECT_URI);

        expect(start)
            .toEqual({ status: 'unsupported' });
        expect(world.requests)
            .toHaveLength(0);
    });
});
