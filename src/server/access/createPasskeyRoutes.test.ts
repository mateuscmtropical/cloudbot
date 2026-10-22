import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../createApp.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { PasskeyStore } from '../store/PasskeyStore.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { PasskeyService } from './PasskeyService.ts';
import type { WebAuthnLibrary } from './PasskeyService.ts';
import { SetupAccess } from './SetupAccess.ts';

// app.request builds its URL on http://localhost, so this is the page's own origin.
const OWN_ORIGIN = 'http://localhost';
const JSON_HEADERS = { 'content-type': 'application/json', 'origin': OWN_ORIGIN };

function fakeLibrary(): WebAuthnLibrary {
    return {
        generateRegistrationOptions: vi.fn(() => Promise.resolve({ challenge: 'c1' })),
        generateAuthenticationOptions: vi.fn(() => Promise.resolve({ challenge: 'c1' })),
        verifyRegistrationResponse: vi.fn((options: { expectedChallenge: unknown }) => {
            const check = options.expectedChallenge as (value: string) => boolean;

            const result = check('c1')
                ? { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1]), counter: 0 } } }
                : { verified: false };

            return Promise.resolve(result);
        }),
        verifyAuthenticationResponse: vi.fn((options: { expectedChallenge: unknown }) => {
            const check = options.expectedChallenge as (value: string) => boolean;

            const result = { verified: check('c1'), authenticationInfo: { newCounter: 1 } };

            return Promise.resolve(result);
        }),
    } as unknown as WebAuthnLibrary;
}

describe('passkey routes', () => {
    let opened: OpenedDatabase;
    let access: SetupAccess;
    let store: PasskeyStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
        store = new PasskeyStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    function buildApp(): ReturnType<typeof createApp> {
        const passkeys = new PasskeyService({ store, access, publicUrl: OWN_ORIGIN, library: fakeLibrary() });

        return createApp({ version: 'test', access, passkeys, webRoot: '/nonexistent' });
    }

    it('adds a passkey only for the signed-in owner', async () => {
        const app = buildApp();
        const setupCode = await access.issueSetupCode();
        const sessionToken = await access.redeemSetupCode(setupCode);
        const cookie = `cloudbot_session=${sessionToken ?? ''}`;

        const anonymous = await app.request('/api/passkeys/register/options', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
        const options = await app.request('/api/passkeys/register/options', { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: '{}' });
        const verified = await app.request('/api/passkeys/register/verify', { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ response: { id: 'cred-1' }, name: 'Laptop' }) });

        expect(anonymous.status)
            .toBe(401);
        expect(options.status)
            .toBe(200);
        expect(await verified.json())
            .toMatchObject({ id: 'cred-1', name: 'Laptop' });
    });

    it('signs the owner in with a passkey and sets the session cookie', async () => {
        const app = buildApp();

        await store.add({ id: 'cred-1', publicKey: 'AQ', counter: 0, transports: [], name: 'Laptop' });
        const options = await app.request('/auth/passkey/options', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
        const verified = await app.request('/auth/passkey/verify', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ id: 'cred-1' }) });
        const setCookie = verified.headers.get('set-cookie') ?? '';
        const sessionToken = /cloudbot_session=([^;]+)/.exec(setCookie)?.[1];

        expect(options.status)
            .toBe(200);
        expect(verified.status)
            .toBe(204);
        expect(setCookie)
            .toContain('HttpOnly');
        expect(await access.isValidSession(sessionToken))
            .toBe(true);
    });

    it('refuses a sign-in from another origin, a non-JSON body and a malformed answer', async () => {
        const app = buildApp();

        await store.add({ id: 'cred-1', publicKey: 'AQ', counter: 0, transports: [], name: 'Laptop' });
        const crossOrigin = await app.request('/auth/passkey/options', { method: 'POST', headers: { ...JSON_HEADERS, origin: 'https://evil.example' }, body: '{}' });
        const formBody = await app.request('/auth/passkey/verify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': OWN_ORIGIN }, body: 'id=cred-1' });
        const malformed = await app.request('/auth/passkey/verify', { method: 'POST', headers: JSON_HEADERS, body: '[1, 2]' });

        expect(crossOrigin.status)
            .toBe(403);
        expect(formBody.status)
            .toBeGreaterThanOrEqual(400);
        expect(formBody.headers.get('set-cookie'))
            .toBeNull();
        expect(malformed.status)
            .toBe(400);
        expect(malformed.headers.get('set-cookie'))
            .toBeNull();
    });
});
