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
    AuthenticatorTransport,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { checkPersonName } from '../../shared/peopleTypes.ts';
import { HubPasskeyLimitError, MAX_HUB_PASSKEYS } from './HubPasskeyStore.ts';
import type { HubPasskeyRecord, HubPasskeyStore, NewHubPasskey } from './HubPasskeyStore.ts';

interface HubWebAuthnLibrary {
    generateRegistrationOptions: typeof generateRegistrationOptions;
    verifyRegistrationResponse: typeof verifyRegistrationResponse;
    generateAuthenticationOptions: typeof generateAuthenticationOptions;
    verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

interface HubPasskeyServiceOptions {
    store: HubPasskeyStore;
    domain: string;
    now?: (() => number) | undefined;
    library?: HubWebAuthnLibrary | undefined;
}

interface HubPasskeySummary {
    id: string;
    label: string;
    createdAt: number;
}

interface RelyingPartyContext {
    rpId: string;
    origin: string;
}

interface ChallengePayload {
    expiresAt: number;
    kind: ChallengeKind;
    personName: string;
    origin: string;
    rpId: string;
    nonce: string;
}

type ChallengeKind = 'register' | 'login';

const RP_NAME = 'CloudBot';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAC_BYTES = 32;
const NONCE_BYTES = 16;
const MAX_LABEL_LENGTH = 60;
const DEFAULT_LABEL = 'This device';
const SUPPORTED_TRANSPORTS = new Set(['ble', 'hybrid', 'internal', 'nfc', 'usb']);

const DEFAULT_LIBRARY: HubWebAuthnLibrary = {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
};

class HubPasskeyError extends Error {}

function cleanLabel(label: unknown): string {
    const cleaned = typeof label === 'string'
        ? label.replace(/\s+/g, ' ')
                .trim()
        : '';

    return cleaned === '' ? DEFAULT_LABEL : cleaned.slice(0, MAX_LABEL_LENGTH);
}

function isAuthenticatorTransport(transport: string): transport is AuthenticatorTransport {
    return SUPPORTED_TRANSPORTS.has(transport);
}

function summarize(passkey: HubPasskeyRecord): HubPasskeySummary {
    return { id: passkey.credentialId, label: passkey.label, createdAt: passkey.createdAt };
}

function isChallengePayload(value: unknown): value is ChallengePayload {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const payload = value as Record<string, unknown>;

    return typeof payload.expiresAt === 'number'
        && (payload.kind === 'register' || payload.kind === 'login')
        && typeof payload.personName === 'string'
        && typeof payload.origin === 'string'
        && typeof payload.rpId === 'string'
        && typeof payload.nonce === 'string';
}

function addPasskey(store: HubPasskeyStore, passkey: NewHubPasskey): HubPasskeyRecord {
    try {
        const added = store.add(passkey);

        return added;
    } catch (error: unknown) {
        if (error instanceof HubPasskeyLimitError) {
            const message = error.message;

            throw new HubPasskeyError(message);
        }

        throw error;
    }
}
class HubPasskeyService {
    private readonly store: HubPasskeyStore;
    private readonly domain: string;
    private readonly isLocalDomain: boolean;
    private readonly now: () => number;
    private readonly library: HubWebAuthnLibrary;
    private readonly challengeKey = randomBytes(32);
    private readonly usedChallenges = new Map<string, number>();

    constructor(options: HubPasskeyServiceOptions) {
        this.store = options.store;
        this.domain = options.domain.toLowerCase()
            .replace(/^\.+|\.+$/g, '');
        this.isLocalDomain = this.domain === 'localhost';
        this.now = options.now ?? (() => Date.now());
        this.library = options.library ?? DEFAULT_LIBRARY;

        const domainAddress = new URL('https://' + this.domain);

        if (isIP(domainAddress.hostname) !== 0) {
            throw new HubPasskeyError('Passkeys need a domain name for each person.');
        }
    }

    async registrationOptions(personName: string, requestUrl: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
        const relyingParty = this.getRelyingParty(personName, requestUrl);
        const existing = this.store.list(personName);

        if (existing.length >= MAX_HUB_PASSKEYS) {
            throw new HubPasskeyError('There are already ' + String(MAX_HUB_PASSKEYS) + ' passkeys. Remove one first.');
        }

        const userId = Buffer.from(personName);
        const options = await this.library.generateRegistrationOptions({
            rpName: RP_NAME,
            rpID: relyingParty.rpId,
            userID: userId,
            userName: personName,
            userDisplayName: personName,
            challenge: this.makeChallenge('register', personName, relyingParty),
            attestationType: 'none',
            excludeCredentials: existing.map(passkey => ({
                id: passkey.credentialId,
                transports: passkey.transports as AuthenticatorTransport[],
            })),
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });

        return options;
    }

    async verifyRegistration(response: RegistrationResponseJSON, personName: string, requestUrl: string, label: unknown): Promise<HubPasskeySummary> {
        const relyingParty = this.getRelyingParty(personName, requestUrl);
        let usedChallenge = '';
        let verification: Awaited<ReturnType<HubWebAuthnLibrary['verifyRegistrationResponse']>>;

        try {
            verification = await this.library.verifyRegistrationResponse({
                response,
                expectedChallenge: (challenge) => {
                    if (!this.isChallengeValid(challenge, 'register', personName, relyingParty)) {
                        return false;
                    }

                    usedChallenge = challenge;
                    this.markChallengeUsed(challenge);

                    return true;
                },
                expectedOrigin: relyingParty.origin,
                expectedRPID: relyingParty.rpId,
                requireUserVerification: true,
            });
        } catch (error: unknown) {
            this.usedChallenges.delete(usedChallenge);

            throw error;
        }

        if (!verification.verified) {
            this.usedChallenges.delete(usedChallenge);

            throw new HubPasskeyError('The passkey could not be checked. Try again.');
        }

        const credential = verification.registrationInfo.credential;
        const publicKey = Buffer.from(credential.publicKey)
            .toString('base64url');
        const transports = credential.transports ?? [];
        const added = addPasskey(this.store, {
            personName,
            credentialId: credential.id,
            publicKey,
            counter: credential.counter,
            transports,
            label: cleanLabel(label),
        });

        return summarize(added);
    }

    async loginOptions(personName: string, requestUrl: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
        const relyingParty = this.getRelyingParty(personName, requestUrl);
        const challenge = this.makeChallenge('login', personName, relyingParty);
        const options = await this.library.generateAuthenticationOptions({
            rpID: relyingParty.rpId,
            challenge,
            allowCredentials: [],
            userVerification: 'required',
        });

        return options;
    }

    async verifyLogin(response: AuthenticationResponseJSON, personName: string, requestUrl: string): Promise<string> {
        const relyingParty = this.getRelyingParty(personName, requestUrl);
        const passkey = typeof response.id === 'string' ? this.store.get(personName, response.id) : undefined;

        if (passkey === undefined) {
            throw new HubPasskeyError('The passkey could not be checked. Try again.');
        }

        const publicKey = Buffer.from(passkey.publicKey, 'base64url');
        let usedChallenge = '';
        let verification: Awaited<ReturnType<HubWebAuthnLibrary['verifyAuthenticationResponse']>>;

        try {
            verification = await this.library.verifyAuthenticationResponse({
                response,
                expectedChallenge: (challenge) => {
                    if (!this.isChallengeValid(challenge, 'login', personName, relyingParty)) {
                        return false;
                    }

                    usedChallenge = challenge;
                    this.markChallengeUsed(challenge);

                    return true;
                },
                expectedOrigin: relyingParty.origin,
                expectedRPID: relyingParty.rpId,
                credential: {
                    id: passkey.credentialId,
                    publicKey: new Uint8Array(publicKey),
                    counter: passkey.counter,
                    transports: passkey.transports.filter(isAuthenticatorTransport),
                },
                requireUserVerification: true,
            });
        } catch (error: unknown) {
            this.usedChallenges.delete(usedChallenge);

            throw error;
        }

        if (!verification.verified) {
            this.usedChallenges.delete(usedChallenge);

            throw new HubPasskeyError('The passkey could not be checked. Try again.');
        }

        this.store.updateCounter(personName, passkey.credentialId, verification.authenticationInfo.newCounter);

        return personName;
    }

    list(personName: string): HubPasskeySummary[] {
        const passkeys = this.store.list(personName);

        return passkeys.map(summarize);
    }

    remove(personName: string, credentialId: string): boolean {
        return this.store.remove(personName, credentialId);
    }

    private getRelyingParty(personName: string, requestUrl: string): RelyingPartyContext {
        const nameError = checkPersonName(personName);

        if (nameError !== undefined) {
            throw new HubPasskeyError(nameError);
        }

        const rpId = personName + '.' + this.domain;
        const url = new URL(requestUrl);

        if (url.hostname.toLowerCase() !== rpId) {
            throw new HubPasskeyError('Passkeys can only be used at your own address.');
        }

        if (this.isLocalDomain) {
            if (url.protocol !== 'http:') {
                throw new HubPasskeyError('Local passkeys need the http address for this server.');
            }

            return { rpId, origin: url.origin };
        }

        const expectedOrigin = 'https://' + rpId;

        if (url.host.toLowerCase() !== rpId) {
            throw new HubPasskeyError('Passkeys can only be used at your own address.');
        }

        return { rpId, origin: expectedOrigin };
    }

    private makeChallenge(kind: ChallengeKind, personName: string, relyingParty: RelyingPartyContext): Uint8Array<ArrayBuffer> {
        const payload: ChallengePayload = {
            expiresAt: this.now() + CHALLENGE_TTL_MS,
            kind,
            personName,
            origin: relyingParty.origin,
            rpId: relyingParty.rpId,
            nonce: randomBytes(NONCE_BYTES)
                .toString('base64url'),
        };
        const payloadJson = JSON.stringify(payload);
        const payloadBytes = Buffer.from(payloadJson);
        const mac = this.signChallenge(payloadBytes);
        const challengeBytes = Buffer.concat([payloadBytes, mac]);
        const challenge = new Uint8Array(new ArrayBuffer(challengeBytes.length));

        challenge.set(challengeBytes);

        return challenge;
    }

    private signChallenge(payload: Buffer): Buffer {
        const hmac = createHmac('sha256', this.challengeKey);

        hmac.update(payload);

        return hmac.digest();
    }

    private isChallengeValid(challenge: string, kind: ChallengeKind, personName: string, relyingParty: RelyingPartyContext): boolean {
        this.forgetExpiredChallenges();
        const challengeBytes = Buffer.from(challenge, 'base64url');

        if (challengeBytes.length <= CHALLENGE_MAC_BYTES || this.usedChallenges.has(challenge)) {
            return false;
        }

        const payloadBytes = challengeBytes.subarray(0, challengeBytes.length - CHALLENGE_MAC_BYTES);
        const receivedMac = challengeBytes.subarray(challengeBytes.length - CHALLENGE_MAC_BYTES);
        const expectedMac = this.signChallenge(payloadBytes);

        if (!timingSafeEqual(receivedMac, expectedMac)) {
            return false;
        }

        let payloadValue: unknown;

        try {
            const payloadJson = payloadBytes.toString('utf8');

            payloadValue = JSON.parse(payloadJson);
        } catch {
            return false;
        }

        if (!isChallengePayload(payloadValue)) {
            return false;
        }

        return payloadValue.expiresAt > this.now()
            && payloadValue.kind === kind
            && payloadValue.personName === personName
            && payloadValue.origin === relyingParty.origin
            && payloadValue.rpId === relyingParty.rpId;
    }

    private markChallengeUsed(challenge: string): void {
        const challengeBytes = Buffer.from(challenge, 'base64url');
        const payloadBytes = challengeBytes.subarray(0, challengeBytes.length - CHALLENGE_MAC_BYTES);
        const payloadText = payloadBytes.toString('utf8');
        const payloadValue: unknown = JSON.parse(payloadText);

        if (isChallengePayload(payloadValue)) {
            this.usedChallenges.set(challenge, payloadValue.expiresAt);
        }
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

export { HubPasskeyError, HubPasskeyService };
export type { HubPasskeyServiceOptions, HubPasskeySummary, HubWebAuthnLibrary };
