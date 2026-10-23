import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const HASH_PREFIX = 'scrypt';
const HASH_PARTS = 3;
const PASSWORD_LENGTH = 16;
// No 0, O, 1, l or I, so a password read from a card is not mistyped.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scrypt(password, salt, KEY_BYTES, (error, key) => {
            if (error === null) {
                resolve(key);
            } else {
                reject(error);
            }
        });
    });
}

// The stored form is scrypt$<salt hex>$<key hex>. Every hash has its own random salt.
async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(password, salt);

    return `${HASH_PREFIX}$${salt.toString('hex')}$${key.toString('hex')}`;
}

// A stored value that is not in the form above never matches, and never throws.
async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    const [prefix, saltHex, keyHex] = parts;

    if (parts.length !== HASH_PARTS || prefix !== HASH_PREFIX || saltHex === undefined || keyHex === undefined) {
        return false;
    }

    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    const key = await deriveKey(password, salt);

    return key.length === expectedKey.length && timingSafeEqual(key, expectedKey);
}

// A random password for a new person or a reset. About 91 bits.
function generatePassword(): string {
    const characters = Array.from({ length: PASSWORD_LENGTH }, () => {
        const index = randomInt(PASSWORD_ALPHABET.length);

        return PASSWORD_ALPHABET.charAt(index);
    });

    return characters.join('');
}

export { generatePassword, hashPassword, verifyPassword };
