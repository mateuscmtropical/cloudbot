import { describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { AppOAuthTokens, oauthSecretName } from './AppOAuthTokens.ts';
import type { FetchFunction } from './probeAppServer.ts';

const BOT_ID = 'bot-1';
const SITE = 'https://mcp.example.com';
const NOW = 1_000_000;

function storedValue(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ accessToken: 'at-old', refreshToken: 'rt-1', expiresAt: NOW + 3_600_000, clientId: 'client-1', tokenEndpoint: 'https://auth.example.com/token', ...overrides });
}

function setup(fetchFunction: FetchFunction): { tokens: AppOAuthTokens; saved: Map<string, BotSecret> } {
    const saved = new Map<string, BotSecret>();
    const tokens = new AppOAuthTokens({
        secrets: {
            read: (_botId, name) => saved.get(name),
            save: (_botId, name, site, value) => {
                saved.set(name, { site, value });
            },
        },
        fetchFunction,
        now: () => NOW,
    });

    return { tokens, saved };
}

describe('AppOAuthTokens', () => {
    it('names the secret after the app, in the form the vault takes', () => {
        expect(oauthSecretName('linear'))
            .toMatch(/^OAUTH_LINEAR_[0-9A-F]{8}$/);
        expect(oauthSecretName('custom-a-very-long-host-name-example').length)
            .toBeLessThanOrEqual(32);
        expect(oauthSecretName('custom-a-very-long-host-name-example'))
            .toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    });

    it('gives two long names that start alike two different secrets', () => {
        expect(oauthSecretName('custom-aaaaaaaaaaaaaaaaaaaax'))
            .not.toBe(oauthSecretName('custom-aaaaaaaaaaaaaaaaaaaay'));
    });

    it('gives the saved access token while it is good, with no request', async () => {
        const requests: string[] = [];
        const { tokens } = setup((url) => {
            requests.push(url);

            return Promise.reject(new Error('no request expected'));
        });

        const token = await tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: storedValue() });

        expect(token)
            .toBe('at-old');
        expect(requests)
            .toHaveLength(0);
    });

    it('gives undefined for a plain token, so it is sent as it is', async () => {
        const { tokens } = setup(() => Promise.reject(new Error('no request expected')));

        const token = await tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: 'just-a-token' });

        expect(token)
            .toBeUndefined();
    });

    it('refreshes an access token that is about to end, and keeps the new one in the vault', async () => {
        const forms: string[] = [];
        const { tokens, saved } = setup((_url, init) => {
            forms.push(typeof init.body === 'string' ? init.body : '');

            return Promise.resolve(new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });

        const secret = { site: SITE, value: storedValue({ expiresAt: NOW + 1000 }) };

        saved.set('OAUTH_X_00000000', secret);

        const token = await tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', secret);

        expect(token)
            .toBe('at-new');

        const form = new URLSearchParams(forms[0]);

        expect(form.get('grant_type'))
            .toBe('refresh_token');
        expect(form.get('refresh_token'))
            .toBe('rt-1');

        const after = JSON.parse(saved.get('OAUTH_X_00000000')?.value ?? '{}') as Record<string, unknown>;

        expect(after['accessToken'])
            .toBe('at-new');
        // The server sent no new refresh token, so the old one stays good.
        expect(after['refreshToken'])
            .toBe('rt-1');
        expect(saved.get('OAUTH_X_00000000')?.site)
            .toBe(SITE);
    });

    it('makes one refresh for requests that arrive together', async () => {
        let calls = 0;
        const { tokens } = setup(() => {
            calls += 1;

            return Promise.resolve(new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
        const secret = { site: SITE, value: storedValue({ expiresAt: NOW }) };

        const results = await Promise.all([
            tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', secret),
            tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', secret),
        ]);

        expect(results)
            .toEqual(['at-new', 'at-new']);
        expect(calls)
            .toBe(1);
    });

    it('fails with a message to connect again when the refresh is refused', async () => {
        const { tokens } = setup(() => Promise.resolve(new Response('no', { status: 400 })));

        await expect(tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: storedValue({ expiresAt: NOW }) }))
            .rejects
            .toThrow('Connect the app again');
    });

    it('keeps using a token that is about to end when it cannot be renewed, until it ends', async () => {
        const { tokens } = setup(() => Promise.resolve(new Response('no', { status: 400 })));

        const token = await tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: storedValue({ expiresAt: NOW + 30_000, refreshToken: undefined }) });

        expect(token)
            .toBe('at-old');
    });

    it('does not overwrite a sign-in that was replaced while the refresh ran', async () => {
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { tokens, saved } = setup(async () => {
            await gate;

            return new Response(JSON.stringify({ access_token: 'at-new', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const original = { site: SITE, value: storedValue({ expiresAt: NOW }) };

        saved.set('OAUTH_X_00000000', original);

        const refreshing = tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', original);

        saved.set('OAUTH_X_00000000', { site: 'https://other.example.com', value: storedValue({ accessToken: 'at-other', refreshToken: 'rt-other' }) });
        release?.();
        await refreshing;

        expect(saved.get('OAUTH_X_00000000')?.site)
            .toBe('https://other.example.com');
        expect(saved.get('OAUTH_X_00000000')?.value)
            .toContain('at-other');
    });

    it('does not share a refresh between two sites', async () => {
        let calls = 0;
        const { tokens } = setup(() => {
            calls += 1;

            return Promise.resolve(new Response(JSON.stringify({ access_token: `at-${String(calls)}`, expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });

        await Promise.all([
            tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: storedValue({ expiresAt: NOW }) }),
            tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: 'https://other.example.com', value: storedValue({ expiresAt: NOW, refreshToken: 'rt-other' }) }),
        ]);

        expect(calls)
            .toBe(2);
    });

    it('fails when the access token ended and there is no refresh token', async () => {
        const { tokens } = setup(() => Promise.reject(new Error('no request expected')));

        await expect(tokens.accessToken(BOT_ID, 'OAUTH_X_00000000', { site: SITE, value: storedValue({ expiresAt: NOW, refreshToken: undefined }) }))
            .rejects
            .toThrow('Connect the app again');
    });
});
