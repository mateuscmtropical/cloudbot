import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import type { PersonRecord } from '../contract.ts';
import { openHubDatabase } from '../store/openHubDatabase.ts';
import { SqlitePeopleStore } from '../store/SqlitePeopleStore.ts';
import { createHubPasskeyTables, SqliteHubPasskeyStore } from './HubPasskeyStore.ts';
import { HubPasskeyService } from './HubPasskeyService.ts';
import type { HubWebAuthnLibrary } from './HubPasskeyService.ts';

const REGISTRATION = {
    id: 'credential-1',
    rawId: 'credential-1',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
} as unknown as RegistrationResponseJSON;
const LOGIN = {
    id: 'credential-1',
    rawId: 'credential-1',
    type: 'public-key',
    response: {},
    clientExtensionResults: {},
} as unknown as AuthenticationResponseJSON;

interface FakeChallengeIssueOptions {
    challenge: Uint8Array;
}

interface FakeIssuedOptions {
    challenge: string;
}

interface FakeChallengeCheckOptions {
    expectedChallenge: unknown;
}

interface FakeLibrary extends HubWebAuthnLibrary {
    lastChallenge: () => string;
}

function fakeLibrary(): FakeLibrary {
    let lastChallenge = '';
    const issue = (options: FakeChallengeIssueOptions): Promise<FakeIssuedOptions> => {
        lastChallenge = Buffer.from(options.challenge)
            .toString('base64url');

        return Promise.resolve({ challenge: lastChallenge });
    };

    return {
        lastChallenge: () => lastChallenge,
        generateRegistrationOptions: vi.fn(issue),
        generateAuthenticationOptions: vi.fn(issue),
        verifyRegistrationResponse: vi.fn((options: FakeChallengeCheckOptions) => {
            const checkChallenge = options.expectedChallenge as (challenge: string) => boolean;
            const isValid = checkChallenge(lastChallenge);
            const result = isValid
                ? {
                        verified: true,
                        registrationInfo: {
                            credential: {
                                id: 'credential-1',
                                publicKey: new Uint8Array([1, 2, 3]),
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
            const result = {
                verified: checkChallenge(lastChallenge),
                authenticationInfo: { newCounter: 7 },
            };

            return Promise.resolve(result);
        }),
    } as unknown as FakeLibrary;
}

function makePerson(name: string): PersonRecord {
    return {
        name,
        role: 'member',
        state: 'active',
        passwordHash: 'hash',
        mustChangePassword: false,
        instanceSecret: 'secret',
        createdAt: 1,
        lastSeenAt: null,
    };
}

describe('HubPasskeyService', () => {
    let database: ReturnType<typeof openHubDatabase>;
    let passkeys: SqliteHubPasskeyStore;
    let clock: number;

    beforeEach(() => {
        database = openHubDatabase(':memory:');
        const people = new SqlitePeopleStore(database);

        people.add(makePerson('maria'));
        people.add(makePerson('joao'));
        createHubPasskeyTables(database);
        clock = 1000;
        passkeys = new SqliteHubPasskeyStore(database, { now: () => clock });
    });

    afterEach(() => {
        database.close();
    });

    function createService(library: HubWebAuthnLibrary): HubPasskeyService {
        return new HubPasskeyService({ store: passkeys, domain: 'example.test', now: () => clock, library });
    }

    it('registers a discoverable passkey on the person’s host with a clean label', async () => {
        const library = fakeLibrary();
        const service = createService(library);

        await service.registrationOptions('maria', 'https://maria.example.test/__hub/passkey/register/options');
        const added = await service.verifyRegistration(REGISTRATION, 'maria', 'https://maria.example.test/__hub/passkey/register/verify', '  My   phone ');

        expect(vi.mocked(library.generateRegistrationOptions).mock.calls[0]?.[0])
            .toMatchObject({
                rpID: 'maria.example.test',
                userName: 'maria',
                attestationType: 'none',
                authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
            });
        expect(library.verifyRegistrationResponse)
            .toHaveBeenCalledWith(expect.objectContaining({
                expectedOrigin: 'https://maria.example.test',
                expectedRPID: 'maria.example.test',
                requireUserVerification: true,
            }));
        expect(added)
            .toMatchObject({ id: 'credential-1', label: 'My phone' });
        expect(passkeys.get('maria', 'credential-1'))
            .toMatchObject({ publicKey: 'AQID', transports: ['internal'] });
    });

    it('signs the matching person in and stores the authenticator counter', async () => {
        const library = fakeLibrary();
        const service = createService(library);

        passkeys.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        await service.loginOptions('maria', 'https://maria.example.test/__hub/passkey/login/options');
        const signedInName = await service.verifyLogin(LOGIN, 'maria', 'https://maria.example.test/__hub/passkey/login/verify');

        expect(signedInName)
            .toBe('maria');
        expect(passkeys.get('maria', 'credential-1')?.counter)
            .toBe(7);
        expect(vi.mocked(library.generateAuthenticationOptions).mock.calls[0]?.[0])
            .toMatchObject({ rpID: 'maria.example.test', allowCredentials: [], userVerification: 'required' });
    });

    it('refuses a credential from another person’s address', async () => {
        const service = createService(fakeLibrary());

        passkeys.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        await service.loginOptions('joao', 'https://joao.example.test/__hub/passkey/login/options');

        await expect(service.verifyLogin(LOGIN, 'joao', 'https://joao.example.test/__hub/passkey/login/verify'))
            .rejects.toThrow('could not be checked');
    });

    it('refuses an answer sent for a different subdomain', async () => {
        const service = createService(fakeLibrary());

        await service.registrationOptions('maria', 'https://maria.example.test/__hub/passkey/register/options');

        await expect(service.verifyRegistration(REGISTRATION, 'maria', 'https://joao.example.test/__hub/passkey/register/verify', 'Phone'))
            .rejects.toThrow('own address');
    });

    it('refuses a replayed challenge and one that expired after five minutes', async () => {
        const service = createService(fakeLibrary());

        passkeys.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });
        await service.loginOptions('maria', 'https://maria.example.test/__hub/passkey/login/options');
        await service.verifyLogin(LOGIN, 'maria', 'https://maria.example.test/__hub/passkey/login/verify');

        await expect(service.verifyLogin(LOGIN, 'maria', 'https://maria.example.test/__hub/passkey/login/verify'))
            .rejects.toThrow('could not be checked');

        await service.loginOptions('maria', 'https://maria.example.test/__hub/passkey/login/options');
        clock += 5 * 60 * 1000 + 1;

        await expect(service.verifyLogin(LOGIN, 'maria', 'https://maria.example.test/__hub/passkey/login/verify'))
            .rejects.toThrow('could not be checked');
    });

    it('does not let one person exceed ten passkeys', async () => {
        const service = createService(fakeLibrary());
        const credentials = Array.from({ length: 10 }, (_unused, index) => ({
            personName: 'maria',
            credentialId: 'credential-' + String(index),
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Key',
        }));

        credentials.forEach(credential => passkeys.add(credential));

        await expect(service.registrationOptions('maria', 'https://maria.example.test/__hub/passkey/register/options'))
            .rejects.toThrow('already 10');
    });

    it('uses the local subdomain and request port as its origin', async () => {
        const library = fakeLibrary();
        const service = new HubPasskeyService({ store: passkeys, domain: 'localhost', library });

        await service.loginOptions('maria', 'http://maria.localhost:3200/__hub/passkey/login/options');

        expect(library.generateAuthenticationOptions)
            .toHaveBeenCalledWith(expect.objectContaining({ rpID: 'maria.localhost' }));
    });

    it('lists and removes only the person’s own passkeys', () => {
        const service = createService(fakeLibrary());

        passkeys.add({
            personName: 'maria',
            credentialId: 'credential-1',
            publicKey: 'AQID',
            counter: 0,
            transports: [],
            label: 'Phone',
        });

        expect(service.list('maria'))
            .toEqual([{ id: 'credential-1', label: 'Phone', createdAt: 1000 }]);
        expect(service.remove('joao', 'credential-1'))
            .toBe(false);
        expect(service.remove('maria', 'credential-1'))
            .toBe(true);
    });
});
