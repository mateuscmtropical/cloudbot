import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { ConnectedAppStore } from '../store/ConnectedAppStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { AppOAuth } from './AppOAuth.ts';
import type { AppOAuthDeps } from './AppOAuth.ts';
import { AppOAuthTokens, oauthSecretName } from './AppOAuthTokens.ts';
import { AppProxy } from './AppProxy.ts';
import { ConnectedApps } from './ConnectedApps.ts';
import { GOOGLE_APPS } from '../../shared/googleApps.ts';
import type { GoogleHubRoute } from './googleEndpoints.ts';
import type { FetchFunction } from './probeAppServer.ts';

const BOT_ID = 'bot-1';
const GMAIL_URL = 'https://gmailmcp.googleapis.com/mcp/v1';
const REDIRECT_URI = 'https://bot.example.com/api/apps/oauth/callback';
const CLIENT_ID = '123456-abc.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-very-secret-value';
const HUB_ROUTE: GoogleHubRoute = { personName: 'maria', apexOrigin: 'https://example.com' };
const APEX_REDIRECT_URI = 'https://example.com/api/apps/oauth/callback';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
const PUBLIC_ADDRESS = '93.184.216.34';
const OTHER_AUTH = 'https://auth.example.com';

interface FakeRequest {
    url: string;
    body: string;
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Google's token endpoint and the Gmail server, plus an ordinary server with discovery for the custom app case.
function fakeNetwork(requests: FakeRequest[], failingHost: { value: string | undefined }): FetchFunction {
    const respond = (url: string, init: RequestInit): Response => {
        const body = typeof init.body === 'string' ? init.body : '';

        requests.push({ url, body });

        if (url === GOOGLE_TOKEN_URL) {
            return jsonResponse({ access_token: 'g-at-1', refresh_token: 'g-rt-1', expires_in: 3599 });
        }

        if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
            return jsonResponse({ resource: 'https://mcp.example.com', authorization_servers: [OTHER_AUTH] });
        }

        if (url === `${OTHER_AUTH}/.well-known/oauth-authorization-server`) {
            return jsonResponse({
                issuer: OTHER_AUTH,
                authorization_endpoint: `${OTHER_AUTH}/authorize`,
                token_endpoint: `${OTHER_AUTH}/token`,
                registration_endpoint: `${OTHER_AUTH}/register`,
                code_challenge_methods_supported: ['S256'],
            });
        }

        if (url === `${OTHER_AUTH}/register`) {
            return jsonResponse({ client_id: 'client-1' }, 201);
        }

        if (!/^https:\/\/(gmail|calendar|drive|docs|sheets)mcp\.googleapis\.com\/mcp\/v1/.test(url)) {
            return new Response('no', { status: 404 });
        }

        if (failingHost.value !== undefined && url.startsWith(failingHost.value)) {
            return new Response('down', { status: 500 });
        }

        const headers = init.headers as Record<string, string>;

        if (headers['authorization'] !== 'Bearer g-at-1') {
            return new Response('no', { status: 401 });
        }

        const parsed = JSON.parse(body) as Record<string, unknown>;

        if (parsed['method'] === 'initialize') {
            return jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
        }

        if (parsed['method'] === 'tools/list') {
            return jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search' }] } });
        }

        return new Response(null, { status: 202 });
    };

    return (url, init) => Promise.resolve(respond(url, init));
}

describe('AppOAuth with Google apps', () => {
    let opened: OpenedDatabase;
    let proxy: AppProxy;
    let requests: FakeRequest[];
    let failingHost: { value: string | undefined };
    let saved: Map<string, BotSecret>;
    let apps: ConnectedApps;
    let fetchFunction: FetchFunction;
    let tokens: AppOAuthTokens;
    let oauth: AppOAuth;
    let store: ConnectedAppStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        proxy = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });
        await proxy.start();
        store = new ConnectedAppStore(opened.db, { now: () => 1000 });
        requests = [];
        failingHost = { value: undefined };
        saved = new Map<string, BotSecret>();

        const secrets = {
            read: (botId: string, name: string): BotSecret | undefined => saved.get(`${botId}:${name}`),
            save: (botId: string, name: string, site: string, value: string): void => {
                saved.set(`${botId}:${name}`, { site, value });
            },
            remove: (botId: string, name: string): void => {
                saved.delete(`${botId}:${name}`);
            },
        };

        fetchFunction = fakeNetwork(requests, failingHost);
        tokens = new AppOAuthTokens({ secrets, fetchFunction, now: () => 1_000_000 });

        apps = new ConnectedApps({
            store,
            secrets,
            proxy,
            allowedHosts: () => Promise.resolve([]),
            addressDeps: allowedHosts => ({ resolve: () => Promise.resolve([PUBLIC_ADDRESS]), localAddresses: [], allowedHosts }),
            fetchFunction,
            oauthTokens: tokens,
        });

        oauth = buildOauth({ googleClient: CLIENT });
    });

    function buildOauth(extra: Partial<AppOAuthDeps>): AppOAuth {
        return new AppOAuth({ connectedApps: apps, tokens, fetchFunction, now: () => 1_000_000, ...extra });
    }

    afterEach(async () => {
        await proxy.close();
        opened.close();
    });

    async function startGmail(): Promise<URL> {
        const start = await oauth.start(BOT_ID, 'google-gmail', GMAIL_URL, REDIRECT_URI);

        if (start.status !== 'redirect') {
            throw new Error(`Expected a redirect, got ${start.status}`);
        }

        return new URL(start.authorizationUrl);
    }

    it('answers google_not_configured when the server has no Google client, without any request', async () => {
        const withoutClient = buildOauth({});
        const start = await withoutClient.start(BOT_ID, 'google-gmail', GMAIL_URL, REDIRECT_URI);

        expect(start)
            .toEqual({ status: 'google_not_configured' });
        expect(requests)
            .toHaveLength(0);
    });

    it('serves every bot with the one client of the server', async () => {
        const start = await oauth.start('bot-2', 'google-gmail', GMAIL_URL, REDIRECT_URI);

        expect(start.status)
            .toBe('redirect');
    });

    it('uses its own address and a plain state when the server is not on a hub', async () => {
        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';

        expect(authorizationUrl.searchParams.get('redirect_uri'))
            .toBe(REDIRECT_URI);
        expect(state)
            .not.toContain('.');
    });

    it('uses the apex address and a state that starts with the person name on a hub', async () => {
        const onHub = buildOauth({ googleClient: CLIENT, googleHub: HUB_ROUTE });
        const start = await onHub.start(BOT_ID, 'google-gmail', GMAIL_URL, REDIRECT_URI);
        const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');
        const state = authorizationUrl.searchParams.get('state') ?? '';

        expect(authorizationUrl.searchParams.get('redirect_uri'))
            .toBe(APEX_REDIRECT_URI);
        expect(state.startsWith('maria.'))
            .toBe(true);
        expect(state.slice('maria.'.length).length)
            .toBeGreaterThan(20);
        expect(state.slice('maria.'.length))
            .not.toContain('.');
    });

    it('trades the code with the same apex address on a hub', async () => {
        const onHub = buildOauth({ googleClient: CLIENT, googleHub: HUB_ROUTE });
        const start = await onHub.start(BOT_ID, 'google-gmail', GMAIL_URL, REDIRECT_URI);
        const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');
        const state = authorizationUrl.searchParams.get('state') ?? '';
        const finished = await onHub.finish({ state, code: 'code-1', error: undefined, issuer: undefined });
        const tokenRequest = requests.find(request => request.url === GOOGLE_TOKEN_URL);
        const form = new URLSearchParams(tokenRequest?.body ?? '');

        expect(finished.outcome)
            .toBe('connected');
        expect(form.get('redirect_uri'))
            .toBe(authorizationUrl.searchParams.get('redirect_uri'));
        expect(form.get('redirect_uri'))
            .toBe(APEX_REDIRECT_URI);
    });

    it('does not use the hub address or state prefix for an app that is not Google', async () => {
        const onHub = buildOauth({ googleClient: CLIENT, googleHub: HUB_ROUTE });
        const start = await onHub.start(BOT_ID, 'custom-example', 'https://mcp.example.com/mcp', REDIRECT_URI);
        const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');

        expect(authorizationUrl.searchParams.get('redirect_uri'))
            .toBe(REDIRECT_URI);
        expect(authorizationUrl.searchParams.get('state'))
            .not.toContain('.');
    });
    it('builds the Google authorization address with the preset scopes, offline access and no resource', async () => {
        const authorizationUrl = await startGmail();

        expect(authorizationUrl.origin + authorizationUrl.pathname)
            .toBe('https://accounts.google.com/o/oauth2/v2/auth');
        expect(authorizationUrl.searchParams.get('client_id'))
            .toBe(CLIENT_ID);
        expect(authorizationUrl.searchParams.get('redirect_uri'))
            .toBe(REDIRECT_URI);
        expect(authorizationUrl.searchParams.get('response_type'))
            .toBe('code');
        expect(authorizationUrl.searchParams.get('scope'))
            .toBe('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose');
        expect(authorizationUrl.searchParams.get('access_type'))
            .toBe('offline');
        expect(authorizationUrl.searchParams.get('prompt'))
            .toBe('consent');
        expect(authorizationUrl.searchParams.has('resource'))
            .toBe(false);
        expect(authorizationUrl.searchParams.get('code_challenge_method'))
            .toBe('S256');
        expect(authorizationUrl.searchParams.get('code_challenge')?.length)
            .toBe(43);
        expect(authorizationUrl.searchParams.get('state')?.length)
            .toBeGreaterThan(20);
        expect(authorizationUrl.href)
            .not.toContain(CLIENT_SECRET);
        expect(requests)
            .toHaveLength(0);
    });

    it('trades the code with the client secret, the verifier and no resource, then connects', async () => {
        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';
        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: 'https://accounts.google.com' });

        expect(finished)
            .toEqual({ outcome: 'connected', botId: BOT_ID, appName: 'google-gmail' });

        const tokenRequest = requests.find(request => request.url === GOOGLE_TOKEN_URL);
        const form = new URLSearchParams(tokenRequest?.body ?? '');
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256')
            .update(verifier)
            .digest('base64url');

        expect(form.get('grant_type'))
            .toBe('authorization_code');
        expect(form.get('code'))
            .toBe('code-1');
        expect(form.get('client_id'))
            .toBe(CLIENT_ID);
        expect(form.get('client_secret'))
            .toBe(CLIENT_SECRET);
        expect(form.get('redirect_uri'))
            .toBe(REDIRECT_URI);
        expect(form.has('resource'))
            .toBe(false);
        expect(challenge)
            .toBe(authorizationUrl.searchParams.get('code_challenge'));

        const secret = saved.get(`${BOT_ID}:${oauthSecretName('google-gmail')}`);
        const stored = JSON.parse(secret?.value ?? '{}') as Record<string, unknown>;

        expect(secret?.site)
            .toBe('https://gmailmcp.googleapis.com');
        expect(stored['tokenEndpoint'])
            .toBe(GOOGLE_TOKEN_URL);
        expect(stored['refreshToken'])
            .toBe('g-rt-1');
        expect(stored['clientSecret'])
            .toBe(CLIENT_SECRET);
        expect(JSON.stringify(await store.list()))
            .not.toContain('g-at-1');
    });

    it('refuses an answer that names another issuer', async () => {
        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';
        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: 'https://evil.example.com' });

        expect(finished.outcome)
            .toBe('failed');
        expect(requests.some(request => request.url === GOOGLE_TOKEN_URL))
            .toBe(false);
    });

    it('renews the access token with the client secret and without a resource', async () => {
        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';

        await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });

        const secretName = oauthSecretName('google-gmail');
        const secret = saved.get(`${BOT_ID}:${secretName}`);
        const stored = JSON.parse(secret?.value ?? '{}') as Record<string, unknown>;
        const expired: BotSecret = { site: secret?.site ?? '', value: JSON.stringify({ ...stored, expiresAt: 1 }) };

        requests.length = 0;
        await tokens.accessToken(BOT_ID, secretName, expired);

        const refreshRequest = requests.find(request => request.url === GOOGLE_TOKEN_URL);
        const form = new URLSearchParams(refreshRequest?.body ?? '');

        expect(form.get('grant_type'))
            .toBe('refresh_token');
        expect(form.get('refresh_token'))
            .toBe('g-rt-1');
        expect(form.get('client_secret'))
            .toBe(CLIENT_SECRET);
        expect(form.has('resource'))
            .toBe(false);
    });

    it('treats a custom app with a Google name and another address like any other server', async () => {
        const start = await oauth.start(BOT_ID, 'google-gmail', 'https://mcp.example.com/mcp', REDIRECT_URI);

        expect(start.status)
            .toBe('redirect');

        const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');

        expect(authorizationUrl.origin)
            .toBe(OTHER_AUTH);
        expect(authorizationUrl.searchParams.get('resource'))
            .toBe('https://mcp.example.com/mcp');
        expect(authorizationUrl.searchParams.has('access_type'))
            .toBe(false);
        expect(requests.some(request => request.url.includes('/.well-known/')))
            .toBe(true);
    });

    it('treats another name at the Google address like a server without a sign-in page, and never reads the client', async () => {
        const start = await oauth.start(BOT_ID, 'my-mail', GMAIL_URL, REDIRECT_URI);

        expect(start)
            .toEqual({ status: 'unsupported' });
        expect(requests.every(request => request.url.includes('/.well-known/')))
            .toBe(true);
    });

    it('starts each card with its own scopes only', async () => {
        const starts = GOOGLE_APPS.map(app => oauth.start(BOT_ID, app.serverName, app.url, REDIRECT_URI));
        const results = await Promise.all(starts);

        results.forEach((start, index) => {
            const app = GOOGLE_APPS[index];
            const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');

            expect(authorizationUrl.searchParams.get('scope'))
                .toBe(app?.scopes.join(' '));
        });
    });

    it('connects only the card that was clicked', async () => {
        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';
        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });
        const records = await store.list();

        expect(finished)
            .toEqual({ outcome: 'connected', botId: BOT_ID, appName: 'google-gmail' });
        expect(records.map(record => record.name))
            .toEqual(['google-gmail']);
    });

    it('reports failed and lists the app as failed when it does not connect', async () => {
        failingHost.value = 'https://gmailmcp.googleapis.com';

        const authorizationUrl = await startGmail();
        const state = authorizationUrl.searchParams.get('state') ?? '';
        const finished = await oauth.finish({ state, code: 'code-1', error: undefined, issuer: undefined });

        expect(finished)
            .toEqual({ outcome: 'failed', botId: BOT_ID, appName: 'google-gmail' });
        expect((await store.list()).map(record => record.status))
            .toEqual(['failed']);
    });

    it('treats a custom app named google at another address like any other server', async () => {
        const start = await oauth.start(BOT_ID, 'google', 'https://mcp.example.com/mcp', REDIRECT_URI);

        expect(start.status)
            .toBe('redirect');

        const authorizationUrl = new URL(start.status === 'redirect' ? start.authorizationUrl : 'https://invalid.example');

        expect(authorizationUrl.origin)
            .toBe(OTHER_AUTH);
        expect(authorizationUrl.searchParams.get('resource'))
            .toBe('https://mcp.example.com/mcp');
        expect(authorizationUrl.searchParams.has('access_type'))
            .toBe(false);
    });
});
