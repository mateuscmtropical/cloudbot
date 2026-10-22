import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { PasskeyStore } from '../store/PasskeyStore.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { PasskeyService } from './PasskeyService.ts';
import type { WebAuthnLibrary } from './PasskeyService.ts';
import { SetupAccess } from './SetupAccess.ts';

const PUBLIC_URL = 'https://bot.example.test';
const REGISTRATION = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} } as unknown as RegistrationResponseJSON;
const LOGIN = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} } as unknown as AuthenticationResponseJSON;

// A fake library: the options carry a fixed challenge, and a verify runs the challenge check it was given, as the real one does.
function fakeLibrary(challenge: string, isVerified = true): WebAuthnLibrary {
    return {
        generateRegistrationOptions: vi.fn(() => Promise.resolve({ challenge })),
        generateAuthenticationOptions: vi.fn(() => Promise.resolve({ challenge })),
        verifyRegistrationResponse: vi.fn((options: { expectedChallenge: unknown }) => {
            const check = options.expectedChallenge as (value: string) => boolean;

            const result = check(challenge) && isVerified
                ? { verified: true, registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } }
                : { verified: false };

            return Promise.resolve(result);
        }),
        verifyAuthenticationResponse: vi.fn((options: { expectedChallenge: unknown }) => {
            const check = options.expectedChallenge as (value: string) => boolean;

            const result = { verified: check(challenge) && isVerified, authenticationInfo: { newCounter: 7 } };

            return Promise.resolve(result);
        }),
    } as unknown as WebAuthnLibrary;
}

describe('PasskeyService', () => {
    let opened: OpenedDatabase;
    let store: PasskeyStore;
    let access: SetupAccess;
    let clock: number;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        clock = 1000;
        store = new PasskeyStore(opened.db, { now: () => clock });
        access = new SetupAccess(new SettingsStore(opened.db));
    });

    afterEach(() => {
        opened.close();
    });

    function service(library: WebAuthnLibrary): PasskeyService {
        return new PasskeyService({ store, access, publicUrl: PUBLIC_URL, now: () => clock, library });
    }

    it('binds the passkey to the public host and origin, and stores it with a clean name', async () => {
        const library = fakeLibrary('challenge-a');
        const passkeys = service(library);

        await passkeys.registrationOptions();
        const added = await passkeys.verifyRegistration(REGISTRATION, '  My   phone ');

        expect(vi.mocked(library.generateRegistrationOptions).mock.calls[0]?.[0])
            .toMatchObject({ rpID: 'bot.example.test', authenticatorSelection: { userVerification: 'required' } });
        expect(library.verifyRegistrationResponse)
            .toHaveBeenCalledWith(expect.objectContaining({ expectedOrigin: 'https://bot.example.test', expectedRPID: 'bot.example.test', requireUserVerification: true }));
        expect(added)
            .toMatchObject({ id: 'cred-1', name: 'My phone' });
        expect(await store.get('cred-1'))
            .toMatchObject({ publicKey: 'AQID', transports: ['internal'] });
    });

    it('signs in with a known passkey, saves its counter and issues a valid session', async () => {
        const passkeys = service(fakeLibrary('challenge-b'));

        await store.add({ id: 'cred-1', publicKey: 'AQID', counter: 0, transports: [], name: 'Phone' });
        await passkeys.loginOptions();
        const sessionToken = await passkeys.verifyLogin(LOGIN);

        expect(await access.isValidSession(sessionToken))
            .toBe(true);
        expect(await store.get('cred-1'))
            .toMatchObject({ counter: 7, lastUsedAt: 1000 });
    });

    it('uses a challenge once: a replayed sign-in fails', async () => {
        const passkeys = service(fakeLibrary('challenge-c'));

        await store.add({ id: 'cred-1', publicKey: 'AQID', counter: 0, transports: [], name: 'Phone' });
        await passkeys.loginOptions();
        await passkeys.verifyLogin(LOGIN);

        await expect(passkeys.verifyLogin(LOGIN))
            .rejects.toThrow('could not be checked');
    });

    it('refuses a sign-in with a registration challenge, and one after five minutes', async () => {
        const passkeys = service(fakeLibrary('challenge-d'));

        await store.add({ id: 'cred-1', publicKey: 'AQID', counter: 0, transports: [], name: 'Phone' });
        await passkeys.registrationOptions();

        await expect(passkeys.verifyLogin(LOGIN))
            .rejects.toThrow('could not be checked');

        await passkeys.loginOptions();
        clock += 5 * 60 * 1000 + 1;

        await expect(passkeys.verifyLogin(LOGIN))
            .rejects.toThrow('could not be checked');
    });

    it('refuses an unknown passkey and gives no session when the check fails', async () => {
        const passkeys = service(fakeLibrary('challenge-e', false));

        await expect(passkeys.verifyLogin(LOGIN))
            .rejects.toThrow('not known');

        await store.add({ id: 'cred-1', publicKey: 'AQID', counter: 0, transports: [], name: 'Phone' });
        await passkeys.loginOptions();

        await expect(passkeys.verifyLogin(LOGIN))
            .rejects.toThrow('could not be checked');
        expect(await access.hasSession())
            .toBe(false);
    });

    it('offers no sign-in before a passkey exists, and refuses a 21st passkey', async () => {
        const passkeys = service(fakeLibrary('challenge-f'));

        await expect(passkeys.loginOptions())
            .rejects.toThrow('No passkey');

        const adds = Array.from({ length: 20 }, (_unused, index) => store.add({ id: `cred-${String(index)}`, publicKey: 'AQID', counter: 0, transports: [], name: 'Key' }));

        await Promise.all(adds);

        await expect(passkeys.registrationOptions())
            .rejects.toThrow('already 20');
    });

    it('lists and removes passkeys without their public keys', async () => {
        const passkeys = service(fakeLibrary('challenge-g'));

        await store.add({ id: 'cred-1', publicKey: 'AQID', counter: 0, transports: [], name: 'Phone' });

        expect(await passkeys.list())
            .toEqual([{ id: 'cred-1', name: 'Phone', createdAt: expect.any(Number) as number, lastUsedAt: null }]);
        expect(await passkeys.remove('cred-1'))
            .toBe(true);
        expect(await passkeys.remove('cred-1'))
            .toBe(false);
    });
});
