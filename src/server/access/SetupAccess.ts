import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SettingsStore } from '../store/SettingsStore.ts';

const SETUP_CODE_HASH_KEY = 'access.setupCodeHash';
const SESSION_HASH_KEY = 'access.sessionHash';
const SECRET_BYTE_LENGTH = 32;

// Only hashes are stored. The raw code and token are 256 random bits, so a
// plain SHA-256 is enough and no salt is needed.
function hashSecret(secret: string): Buffer {
    const hash = createHash('sha256');

    hash.update(secret);

    return hash.digest();
}

function storeHash(secret: string): string {
    const hashedSecret = hashSecret(secret);

    return hashedSecret.toString('hex');
}

function matchesStoredHash(candidate: string, storedHashHex: string | undefined): boolean {
    if (storedHashHex === undefined || storedHashHex === '') {
        return false;
    }

    const candidateHash = hashSecret(candidate);
    const storedHash = Buffer.from(storedHashHex, 'hex');

    // timingSafeEqual throws on different lengths, and a corrupted value must not throw here.
    if (storedHash.length !== candidateHash.length) {
        return false;
    }

    return timingSafeEqual(candidateHash, storedHash);
}

function createRandomSecret(): string {
    const secretBytes = randomBytes(SECRET_BYTE_LENGTH);

    return secretBytes.toString('base64url');
}

class SetupAccess {
    private readonly settings: SettingsStore;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(settings: SettingsStore) {
        this.settings = settings;
    }

    // Replacing the code also clears the session hash, so every old session ends.
    issueSetupCode(): Promise<string> {
        return this.runExclusive(async () => {
            const setupCode = createRandomSecret();
            const setupCodeHash = storeHash(setupCode);

            await this.settings.set(SESSION_HASH_KEY, '');
            await this.settings.set(SETUP_CODE_HASH_KEY, setupCodeHash);

            return setupCode;
        });
    }

    // The code is cleared on success, so a second use of the same link fails.
    // The lock stops two requests from both using the code at the same time.
    redeemSetupCode(setupCode: string): Promise<string | undefined> {
        return this.runExclusive(async () => {
            const storedCodeHash = await this.settings.get(SETUP_CODE_HASH_KEY);

            if (!matchesStoredHash(setupCode, storedCodeHash)) {
                return undefined;
            }

            const sessionToken = createRandomSecret();
            const sessionHash = storeHash(sessionToken);

            await this.settings.set(SESSION_HASH_KEY, sessionHash);
            await this.settings.set(SETUP_CODE_HASH_KEY, '');

            return sessionToken;
        });
    }

    // A new session after another proof of the owner, such as a passkey. Like the setup link, it replaces the old one.
    issueSession(): Promise<string> {
        return this.runExclusive(async () => {
            const sessionToken = createRandomSecret();
            const sessionHash = storeHash(sessionToken);

            await this.settings.set(SESSION_HASH_KEY, sessionHash);

            return sessionToken;
        });
    }

    async isValidSession(sessionToken: string | undefined): Promise<boolean> {
        if (sessionToken === undefined) {
            return false;
        }

        const storedSessionHash = await this.settings.get(SESSION_HASH_KEY);

        return matchesStoredHash(sessionToken, storedSessionHash);
    }

    async hasSession(): Promise<boolean> {
        const storedSessionHash = await this.settings.get(SESSION_HASH_KEY);

        return storedSessionHash !== undefined && storedSessionHash !== '';
    }

    private runExclusive<Result>(task: () => Promise<Result>): Promise<Result> {
        const run = this.queue.then(task);

        this.queue = run.catch(() => undefined);

        return run;
    }
}

export { SetupAccess };
