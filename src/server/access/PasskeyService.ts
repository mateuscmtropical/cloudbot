import {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
    AuthenticationResponseJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';

import type { PasskeyRecord, PasskeyStore } from '../store/PasskeyStore.ts';
import type { SetupAccess } from './SetupAccess.ts';

// The library calls, so tests can replace them. Production uses @simplewebauthn/server.
interface WebAuthnLibrary {
    generateRegistrationOptions: typeof generateRegistrationOptions;
    verifyRegistrationResponse: typeof verifyRegistrationResponse;
    generateAuthenticationOptions: typeof generateAuthenticationOptions;
    verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

interface PasskeyServiceOptions {
    store: PasskeyStore;
    access: SetupAccess;
    // The address the owner opens, such as https://bot.example.com. Passkeys are bound to its host name.
    publicUrl: string;
    now?: (() => number) | undefined;
    library?: WebAuthnLibrary | undefined;
}

type ChallengeKind = 'register' | 'login';

interface PasskeySummary {
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
}

const RP_NAME = 'CloudBot';
const USER_NAME = 'owner';
// A challenge works for five minutes and once.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Sign-in options are a public route, so the number of open challenges is capped. The oldest one goes first.
const MAX_OPEN_CHALLENGES = 20;
const MAX_PASSKEYS = 20;
const MAX_NAME_LENGTH = 60;

const DEFAULT_LIBRARY: WebAuthnLibrary = {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
};

class PasskeyError extends Error {}

function cleanName(name: unknown): string {
    const text = typeof name === 'string'
        ? name.replace(/\s+/g, ' ')
                .trim()
        : '';

    return text === '' ? 'Passkey' : text.slice(0, MAX_NAME_LENGTH);
}

function summarize(record: PasskeyRecord): PasskeySummary {
    return { id: record.id, name: record.name, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt };
}

// Registers the owner's passkeys and signs the owner in with them. A sign-in gives the same session cookie as the
// setup link. The owner adds a passkey only while signed in, so the setup link stays the root of trust.
class PasskeyService {
    private readonly store: PasskeyStore;
    private readonly access: SetupAccess;
    private readonly origin: string;
    private readonly rpID: string;
    private readonly now: () => number;
    private readonly library: WebAuthnLibrary;
    private readonly challenges = new Map<string, { kind: ChallengeKind; expiresAt: number }>();

    constructor(options: PasskeyServiceOptions) {
        const url = new URL(options.publicUrl);

        this.store = options.store;
        this.access = options.access;
        this.origin = url.origin;
        this.rpID = url.hostname;
        this.now = options.now ?? (() => Date.now());
        this.library = options.library ?? DEFAULT_LIBRARY;
    }

    async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
        const existing = await this.store.list();

        if (existing.length >= MAX_PASSKEYS) {
            throw new PasskeyError(`There are already ${String(MAX_PASSKEYS)} passkeys. Remove one first.`);
        }

        const options = await this.library.generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: this.rpID,
            userName: USER_NAME,
            attestationType: 'none',
            excludeCredentials: existing.map(passkey => ({ id: passkey.id, transports: passkey.transports })),
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        });

        this.rememberChallenge(options.challenge, 'register');

        return options;
    }

    async verifyRegistration(response: RegistrationResponseJSON, name: unknown): Promise<PasskeySummary> {
        const verification = await this.library.verifyRegistrationResponse({
            response,
            expectedChallenge: challenge => this.takeChallenge(challenge, 'register'),
            expectedOrigin: this.origin,
            expectedRPID: this.rpID,
            requireUserVerification: true,
        });

        if (!verification.verified) {
            throw new PasskeyError('The passkey could not be checked. Try again.');
        }

        const { credential } = verification.registrationInfo;
        const publicKey = Buffer.from(credential.publicKey)
            .toString('base64url');
        const added = await this.store.add({ id: credential.id, publicKey, counter: credential.counter, transports: credential.transports ?? [], name: cleanName(name) });

        return summarize(added);
    }

    async loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
        const existing = await this.store.list();

        if (existing.length === 0) {
            throw new PasskeyError('No passkey is set up yet. Open the setup link printed by the server.');
        }

        const options = await this.library.generateAuthenticationOptions({
            rpID: this.rpID,
            allowCredentials: existing.map(passkey => ({ id: passkey.id, transports: passkey.transports })),
            userVerification: 'required',
        });

        this.rememberChallenge(options.challenge, 'login');

        return options;
    }

    // Returns a new session token, or throws a PasskeyError with a message for the owner.
    async verifyLogin(response: AuthenticationResponseJSON): Promise<string> {
        const passkey = typeof response.id === 'string' ? await this.store.get(response.id) : undefined;

        if (passkey === undefined) {
            throw new PasskeyError('This passkey is not known here.');
        }

        const publicKey = Buffer.from(passkey.publicKey, 'base64url');
        const verification = await this.library.verifyAuthenticationResponse({
            response,
            expectedChallenge: challenge => this.takeChallenge(challenge, 'login'),
            expectedOrigin: this.origin,
            expectedRPID: this.rpID,
            credential: { id: passkey.id, publicKey: new Uint8Array(publicKey), counter: passkey.counter, transports: passkey.transports },
            requireUserVerification: true,
        });

        if (!verification.verified) {
            throw new PasskeyError('The passkey could not be checked. Try again.');
        }

        await this.store.markUsed(passkey.id, verification.authenticationInfo.newCounter);

        return this.access.issueSession();
    }

    async list(): Promise<PasskeySummary[]> {
        const passkeys = await this.store.list();

        return passkeys.map(summarize);
    }

    remove(id: string): Promise<boolean> {
        return this.store.remove(id);
    }

    private rememberChallenge(challenge: string, kind: ChallengeKind): void {
        const now = this.now();

        this.challenges.forEach((entry, key) => {
            if (entry.expiresAt <= now) {
                this.challenges.delete(key);
            }
        });

        const oldest = this.challenges.keys()
            .next();

        if (this.challenges.size >= MAX_OPEN_CHALLENGES && oldest.done !== true) {
            this.challenges.delete(oldest.value);
        }

        this.challenges.set(challenge, { kind, expiresAt: now + CHALLENGE_TTL_MS });
    }

    // A challenge is used once, whatever the outcome, and only for the kind it was made for.
    private takeChallenge(challenge: string, kind: ChallengeKind): boolean {
        const entry = this.challenges.get(challenge);

        this.challenges.delete(challenge);

        return entry !== undefined && entry.kind === kind && entry.expiresAt > this.now();
    }
}

export { MAX_PASSKEYS, PasskeyError, PasskeyService };
export type { PasskeyServiceOptions, PasskeySummary, WebAuthnLibrary };
