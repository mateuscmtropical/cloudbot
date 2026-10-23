import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

import { requireSameOrigin } from '../../server/access/requireSameOrigin.ts';
import { openHubDatabase } from '../store/openHubDatabase.ts';
import { createHubPasskeyTables, SqliteHubPasskeyStore } from './HubPasskeyStore.ts';
import { HubPasskeyService } from './HubPasskeyService.ts';
import type { HubWebAuthnLibrary } from './HubPasskeyService.ts';
import { createHubPasskeyRoutes } from './createHubPasskeyRoutes.ts';
import type { HubPasskeyPageInput } from './createHubPasskeyRoutes.ts';

interface FakeChallengeIssueOptions {
    challenge: Uint8Array;
}

interface FakeIssuedOptions {
    challenge: string;
}

interface FakeChallengeCheckOptions {
    expectedChallenge: unknown;
}

interface TestRenderedPage {
    html: string;
    csp: string;
}

function fakeLibrary(): HubWebAuthnLibrary {
    let lastChallenge = '';
    const issue = (options: FakeChallengeIssueOptions): Promise<FakeIssuedOptions> => {
        lastChallenge = Buffer.from(options.challenge)
            .toString('base64url');

        return Promise.resolve({ challenge: lastChallenge });
    };

    return {
        generateRegistrationOptions: vi.fn(issue),
        generateAuthenticationOptions: vi.fn(issue),
        verifyRegistrationResponse: vi.fn((options: FakeChallengeCheckOptions) => {
            const checkChallenge = options.expectedChallenge as (challenge: string) => boolean;
            const result = checkChallenge(lastChallenge)
                ? {
                        verified: true,
                        registrationInfo: {
                            credential: {
                                id: 'credential-maria',
                                publicKey: new Uint8Array([1]),
                                counter: 0,
                                transports: ['internal'],
                            },
                        },
                    }
                : { verified: false };

            return Promise.resolve(result);
        }),
        verifyAuthenticationResponse: vi.fn((options: FakeChallengeCheckOptions) => {
            const checkChallenge = options.expectedChallenge as (challenge: string) => boolean;
            const result = { verified: checkChallenge(lastChallenge), authenticationInfo: { newCounter: 1 } };

            return Promise.resolve(result);
        }),
    } as unknown as HubWebAuthnLibrary;
}

describe('createHubPasskeyRoutes', () => {
    let database: ReturnType<typeof openHubDatabase>;
    let store: SqliteHubPasskeyStore;
    let library: HubWebAuthnLibrary;
    let app: Hono;

    beforeEach(() => {
        database = openHubDatabase(':memory:');
        const people = database.prepare('INSERT INTO people (name, role, state, password_hash, must_change_password, instance_secret, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

        people.run('maria', 'member', 'active', 'hash', 0, 'secret-maria', 1, null);
        people.run('joao', 'member', 'active', 'hash', 0, 'secret-joao', 2, null);
        createHubPasskeyTables(database);
        store = new SqliteHubPasskeyStore(database);
        library = fakeLibrary();

        const requireSession: MiddlewareHandler = async (context, next) => {
            if (context.req.header('x-test-session') === undefined) {
                return context.json({ error: 'Sign in first.' }, 401);
            }

            await next();
        };
        const sameOriginCheck = requireSameOrigin();
        const renderPage = (page: HubPasskeyPageInput): TestRenderedPage => ({
            html: page.body + page.scripts.map(script => '<script>' + script + '</script>')
                .join(''),
            csp: 'default-src \'self\'',
        });
        const passkeys = new HubPasskeyService({ store, domain: 'example.test', library });
        const routes = createHubPasskeyRoutes({
            passkeys,
            requireSession,
            sameOriginCheck,
            requestPersonName: (context) => {
                const host = new URL(context.req.url).hostname;

                return host.endsWith('.example.test') ? host.slice(0, -'.example.test'.length) : undefined;
            },
            sessionPersonName: context => context.req.header('x-test-session'),
            isPersonActive: (name) => {
                const person = database.prepare('SELECT state FROM people WHERE name = ?')
                    .get(name);

                return person?.state === 'active';
            },
            startSession: (name, response) => {
                const person = database.prepare('SELECT state FROM people WHERE name = ?')
                    .get(name);

                if (person?.state !== 'active') {
                    return false;
                }

                response.header('set-cookie', 'cloudbot_session=hub-' + name + '; Path=/; HttpOnly; SameSite=Lax');

                return true;
            },
            renderPage,
        });

        app = new Hono();
        app.route('/', routes);
    });

    afterEach(() => {
        database.close();
    });

    it('requires the person’s hub session for registration options', async () => {
        const headers = { 'origin': 'https://maria.example.test', 'content-type': 'application/json' };
        const anonymous = await app.request('https://maria.example.test/__hub/passkey/register/options', {
            method: 'POST',
            headers,
            body: '{}',
        });
        const signedIn = await app.request('https://maria.example.test/__hub/passkey/register/options', {
            method: 'POST',
            headers: { ...headers, 'x-test-session': 'maria' },
            body: '{}',
        });

        expect(anonymous.status)
            .toBe(401);
        expect(signedIn.status)
            .toBe(200);
    });

    it('sets the standard hub session cookie after a public passkey sign-in', async () => {
        store.add({
            personName: 'maria',
            credentialId: 'credential-maria',
            publicKey: 'AQ==',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        const headers = { 'origin': 'https://maria.example.test', 'content-type': 'application/json' };
        const options = await app.request('https://maria.example.test/__hub/passkey/login/options', {
            method: 'POST',
            headers,
            body: '{}',
        });
        const verified = await app.request('https://maria.example.test/__hub/passkey/login/verify', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: 'credential-maria' }),
        });

        expect(options.status)
            .toBe(200);
        expect(verified.status)
            .toBe(204);
        expect(verified.headers.get('set-cookie'))
            .toContain('cloudbot_session=hub-maria');
    });

    it('returns the front door not available page when a passkey person was deactivated before verification', async () => {
        store.add({
            personName: 'maria',
            credentialId: 'credential-maria',
            publicKey: 'AQ==',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        const headers = { 'origin': 'https://maria.example.test', 'content-type': 'application/json' };
        const options = await app.request('https://maria.example.test/__hub/passkey/login/options', {
            method: 'POST',
            headers,
            body: '{}',
        });

        expect(options.status)
            .toBe(200);
        database.prepare('UPDATE people SET state = ? WHERE name = ?')
            .run('inactive', 'maria');
        const verified = await app.request('https://maria.example.test/__hub/passkey/login/verify', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: 'credential-maria' }),
        });

        expect(verified.status)
            .toBe(404);
        expect(await verified.text())
            .toContain('This address is not available.');
        expect(verified.headers.get('set-cookie'))
            .toBeNull();
    });

    it('returns the front door not available page when the person and passkey were deleted before verification', async () => {
        store.add({
            personName: 'maria',
            credentialId: 'credential-maria',
            publicKey: 'AQ==',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        const headers = { 'origin': 'https://maria.example.test', 'content-type': 'application/json' };
        const options = await app.request('https://maria.example.test/__hub/passkey/login/options', {
            method: 'POST',
            headers,
            body: '{}',
        });

        expect(options.status)
            .toBe(200);
        database.prepare('DELETE FROM people WHERE name = ?')
            .run('maria');
        const verified = await app.request('https://maria.example.test/__hub/passkey/login/verify', {
            method: 'POST',
            headers,
            body: JSON.stringify({ id: 'credential-maria' }),
        });

        expect(verified.status)
            .toBe(404);
        expect(await verified.text())
            .toContain('This address is not available.');
        expect(verified.headers.get('set-cookie'))
            .toBeNull();
    });

    it('refuses cross-origin writes and request bodies over 64 KB', async () => {
        const crossOrigin = await app.request('https://maria.example.test/__hub/passkey/login/options', {
            method: 'POST',
            headers: { 'origin': 'https://evil.example.test', 'content-type': 'application/json' },
            body: '{}',
        });
        const tooLarge = await app.request('https://maria.example.test/__hub/passkey/login/verify', {
            method: 'POST',
            headers: { 'origin': 'https://maria.example.test', 'content-type': 'application/json' },
            body: 'x'.repeat(64 * 1024 + 1),
        });

        expect(crossOrigin.status)
            .toBe(403);
        expect(tooLarge.status)
            .toBe(413);
    });

    it('lists and removes only the signed-in person’s passkeys', async () => {
        store.add({
            personName: 'maria',
            credentialId: 'credential-maria',
            publicKey: 'AQ==',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        store.add({
            personName: 'joao',
            credentialId: 'credential-joao',
            publicKey: 'Ag==',
            counter: 0,
            transports: [],
            label: 'Laptop',
        });
        const headers = { 'x-test-session': 'maria' };
        const listed = await app.request('https://maria.example.test/__hub/passkey/list', { headers });
        const wrongPerson = await app.request('https://maria.example.test/__hub/passkey/credential-joao', {
            method: 'DELETE',
            headers: { ...headers, origin: 'https://maria.example.test' },
        });
        const removed = await app.request('https://maria.example.test/__hub/passkey/credential-maria', {
            method: 'DELETE',
            headers: { ...headers, origin: 'https://maria.example.test' },
        });

        const listedBody: unknown = await listed.json();

        expect(listedBody)
            .toEqual([{ id: 'credential-maria', label: 'Phone', createdAt: expect.any(Number) as number }]);
        expect(wrongPerson.status)
            .toBe(404);
        expect(removed.status)
            .toBe(204);
    });

    it('renders the protected passkey management page through the front door renderer', async () => {
        store.add({
            personName: 'maria',
            credentialId: 'credential-maria',
            publicKey: 'AQ==',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        const page = await app.request('https://maria.example.test/__hub/passkeys', {
            headers: { 'x-test-session': 'maria' },
        });

        expect(page.status)
            .toBe(200);
        expect(page.headers.get('content-security-policy'))
            .toBe('default-src \'self\'');
        expect(await page.text())
            .toContain('Remove');
    });
});
