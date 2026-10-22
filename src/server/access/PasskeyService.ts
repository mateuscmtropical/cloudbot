import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

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
const NONCE_BYTES = 16;
const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;
const SIGNED_PART_BYTES = NONCE_BYTES + EXPIRY_BYTES + 1;
const CHALLENGE_KIND_CODES: Record<ChallengeKind, number> = { register: 1, login: 2 };
const IP_HOST_MESSAGE = 'Passkeys need a host name, not an IP address. Set CLOUDBOT_PUBLIC_URL to the name you open CloudBot at.';
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
    // Challenges are signed with a key of this process, so the server keeps no list of open ones that a flood could
    // fill. Only the challenges of good answers are kept, until they expire, so each one works once.
    private readonly challengeKey = randomBytes(32);
    private readonly usedChallenges = new Map<string, number>();
    private readonly isIpHost: boolean;

    // Throws when the address is not a URL, so a bad setting is found at start.
    constructor(options: PasskeyServiceOptions) {
        const url = new URL(options.publicUrl);
        const hostName = url.hostname.replace(/^\[|\]$/g, '');

        this.store = options.store;
        this.access = options.access;
        this.origin = url.origin;
        this.rpID = url.hostname;
        // WebAuthn takes a domain as the relying party id, so an address such as 127.0.0.1 cannot hold a passkey.
        this.isIpHost = isIP(hostName) !== 0;
        this.now = options.now ?? (() => Date.now());
        this.library = options.library ?? DEFAULT_LIBRARY;
    }

    async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
        this.refuseIpHost();
        const existing = await this.store.list();

        if (existing.length >= MAX_PASSKEYS) {
            throw new PasskeyError(`There are already ${String(MAX_PASSKEYS)} passkeys. Remove one first.`);
        }

        const options = await this.library.generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: this.rpID,
            userName: USER_NAME,
            challenge: this.makeChallenge('register'),
            attestationType: 'none',
            excludeCredentials: existing.map(passkey => ({ id: passkey.id, transports: passkey.transports })),
            // A discoverable passkey lets the sign-in name no credential, so the public route lists none.
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });

        return options;
    }

    async verifyRegistration(response: RegistrationResponseJSON, name: unknown): Promise<PasskeySummary> {
        let usedChallenge = '';
        let verification: Awaited<ReturnType<WebAuthnLibrary['verifyRegistrationResponse']>>;

        try {
            verification = await this.library.verifyRegistrationResponse({
                response,
                expectedChallenge: (challenge) => {
                    // Reserved at once, with no await in between, so two copies of one answer cannot both pass.
                    if (!this.isChallengeValid(challenge, 'register')) {
                        return false;
                    }

                    usedChallenge = challenge;
                    this.markChallengeUsed(challenge);

                    return true;
                },
                expectedOrigin: this.origin,
                expectedRPID: this.rpID,
                requireUserVerification: true,
            });
        } catch (error: unknown) {
            this.usedChallenges.delete(usedChallenge);
            throw error;
        }

        // A reserved challenge whose answer failed is released, so a flood of bad answers keeps nothing.
        if (!verification.verified) {
            this.usedChallenges.delete(usedChallenge);
            throw new PasskeyError('The passkey could not be checked. Try again.');
        }

        // Two adds that ran at the same time are checked again here, so the cap holds.
        const existing = await this.store.list();

        if (existing.length >= MAX_PASSKEYS) {
            throw new PasskeyError(`There are already ${String(MAX_PASSKEYS)} passkeys. Remove one first.`);
        }

        const { credential } = verification.registrationInfo;
        const publicKey = Buffer.from(credential.publicKey)
            .toString('base64url');
        const added = await this.store.add({ id: credential.id, publicKey, counter: credential.counter, transports: credential.transports ?? [], name: cleanName(name) });

        return summarize(added);
    }

    // Public. It names no credential, so it tells nothing about the owner's passkeys.
    async loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
        this.refuseIpHost();

        return await this.library.generateAuthenticationOptions({
            rpID: this.rpID,
            challenge: this.makeChallenge('login'),
            allowCredentials: [],
            userVerification: 'required',
        });
    }

    // Returns a new session token, or throws a PasskeyError with a message for the owner.
    async verifyLogin(response: AuthenticationResponseJSON): Promise<string> {
        const passkey = typeof response.id === 'string' ? await this.store.get(response.id) : undefined;

        if (passkey === undefined) {
            throw new PasskeyError('The passkey could not be checked. Try again.');
        }

        const publicKey = Buffer.from(passkey.publicKey, 'base64url');
        let usedChallenge = '';
        let verification: Awaited<ReturnType<WebAuthnLibrary['verifyAuthenticationResponse']>>;

        try {
            verification = await this.library.verifyAuthenticationResponse({
                response,
                expectedChallenge: (challenge) => {
                    // Reserved at once, with no await in between, so two copies of one answer cannot both pass.
                    if (!this.isChallengeValid(challenge, 'login')) {
                        return false;
                    }

                    usedChallenge = challenge;
                    this.markChallengeUsed(challenge);

                    return true;
                },
                expectedOrigin: this.origin,
                expectedRPID: this.rpID,
                credential: { id: passkey.id, publicKey: new Uint8Array(publicKey), counter: passkey.counter, transports: passkey.transports },
                requireUserVerification: true,
            });
        } catch (error: unknown) {
            this.usedChallenges.delete(usedChallenge);
            throw error;
        }

        // A reserved challenge whose answer failed is released, so a flood of bad answers keeps nothing.
        if (!verification.verified) {
            this.usedChallenges.delete(usedChallenge);
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

    private refuseIpHost(): void {
        if (this.isIpHost) {
            throw new PasskeyError(IP_HOST_MESSAGE);
        }
    }

    // A random nonce, the expiry and the kind, signed with the process key.
    private makeChallenge(kind: ChallengeKind): Uint8Array<ArrayBuffer> {
        const nonce = randomBytes(NONCE_BYTES);
        const expiry = Buffer.alloc(EXPIRY_BYTES);

        const expiresAt = BigInt(this.now() + CHALLENGE_TTL_MS);

        expiry.writeBigUInt64BE(expiresAt);
        const signedPart = Buffer.concat([nonce, expiry, Buffer.from([CHALLENGE_KIND_CODES[kind]])]);
        const mac = this.signChallenge(signedPart);
        const challenge = Buffer.concat([signedPart, mac]);
        const copy = new Uint8Array(new ArrayBuffer(challenge.length));

        copy.set(challenge);

        return copy;
    }

    private signChallenge(signedPart: Buffer): Buffer {
        const hmac = createHmac('sha256', this.challengeKey);

        hmac.update(signedPart);

        return hmac.digest();
    }

    // The challenge comes back base64url encoded in the browser's answer.
    private isChallengeValid(challenge: string, kind: ChallengeKind): boolean {
        this.forgetExpiredChallenges();
        const bytes = Buffer.from(challenge, 'base64url');

        if (bytes.length !== SIGNED_PART_BYTES + MAC_BYTES || this.usedChallenges.has(challenge)) {
            return false;
        }

        const signedPart = bytes.subarray(0, SIGNED_PART_BYTES);
        const mac = bytes.subarray(SIGNED_PART_BYTES);
        const expectedMac = this.signChallenge(signedPart);
        const expiryValue = signedPart.readBigUInt64BE(NONCE_BYTES);
        const expiresAt = Number(expiryValue);
        const kindCode = signedPart[SIGNED_PART_BYTES - 1];

        return timingSafeEqual(mac, expectedMac) && kindCode === CHALLENGE_KIND_CODES[kind] && expiresAt > this.now();
    }

    // Only good answers get here, so the list grows only with the owner's own sign-ins and adds.
    private markChallengeUsed(challenge: string): void {
        const bytes = Buffer.from(challenge, 'base64url');
        const expiryValue = bytes.length >= SIGNED_PART_BYTES ? bytes.readBigUInt64BE(NONCE_BYTES) : undefined;
        const expiresAt = expiryValue === undefined ? this.now() + CHALLENGE_TTL_MS : Number(expiryValue);

        this.usedChallenges.set(challenge, expiresAt);
    }

    private forgetExpiredChallenges(): void {
        const now = this.now();

        this.usedChallenges.forEach((expiresAt, challenge) => {
            if (expiresAt <= now) {
                this.usedChallenges.delete(challenge);
            }
        });
    }
}

export { MAX_PASSKEYS, PasskeyError, PasskeyService };
export type { PasskeyServiceOptions, PasskeySummary, WebAuthnLibrary };
