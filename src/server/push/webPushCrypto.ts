import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';

// Web Push encryption (RFC 8291, aes128gcm as RFC 8188 defines it) and the VAPID token (RFC 8292), on node:crypto only.

const RECORD_SIZE = 4096;
const SALT_BYTES = 16;
const AUTH_SECRET_BYTES = 16;
const UNCOMPRESSED_KEY_BYTES = 65;
const TAG_BYTES = 16;
// The header before the record: salt, record size, key id length and the 65 byte sender key.
const HEADER_BYTES = SALT_BYTES + 4 + 1 + UNCOMPRESSED_KEY_BYTES;
// The whole body must fit in 4096 bytes, since that is what push services accept. The record holds the payload,
// one delimiter byte and the tag.
const MAX_PAYLOAD_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1;
// Every record is padded to a multiple of this size, so the length of the body does not say what the notice is.
const PADDING_BLOCK_BYTES = 512;
const LAST_RECORD_DELIMITER = 0x02;
const ES256_RAW_SIGNATURE_ENCODING = 'ieee-p1363';
// A token may live 24 hours at most. 12 hours is the usual choice.
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;
const CURVE_NAME = 'prime256v1';

// The keys the browser gave when it subscribed, both as base64url text.
interface BrowserPushKeys {
    p256dh: string;
    auth: string;
}

// Fixed salt and sender key. Only tests pass this, to compare with the RFC example.
interface EncryptionOverrides {
    salt?: Buffer;
    senderPrivateKey?: Buffer;
}

interface VapidKeyPair {
    // The 65 byte public key as base64url, as the browser takes it in applicationServerKey.
    publicKey: string;
    privateJwk: JsonWebKey;
}

interface VapidTokenInput {
    // The origin of the push service, such as https://fcm.googleapis.com.
    audience: string;
    subject: string;
    nowSeconds: number;
}

function toBase64Url(bytes: Buffer): string {
    return bytes.toString('base64url');
}

function encodeJsonSegment(value: object): string {
    const text = JSON.stringify(value);
    const bytes = Buffer.from(text, 'utf8');

    return toBase64Url(bytes);
}

function expand(inputKey: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
    const derived = hkdfSync('sha256', inputKey, salt, info, length);

    return Buffer.from(derived);
}

// RFC 8188 padding: the delimiter, then zero bytes up to the next multiple of 512. A notice is far smaller than that,
// so every push has the same size. The padding stops at the largest record that fits.
function padRecord(payload: Buffer): Buffer {
    const withDelimiter = payload.length + 1;
    const paddedLength = Math.min(Math.ceil(withDelimiter / PADDING_BLOCK_BYTES) * PADDING_BLOCK_BYTES, MAX_PAYLOAD_BYTES + 1);
    const record = Buffer.alloc(paddedLength);

    payload.copy(record);
    record.writeUInt8(LAST_RECORD_DELIMITER, payload.length);

    return record;
}

// Returns the whole body of the push request: the header with the salt and the sender key, then the encrypted record.
function encryptPushPayload(payload: Buffer, keys: BrowserPushKeys, overrides: EncryptionOverrides = {}): Buffer {
    if (payload.length > MAX_PAYLOAD_BYTES) {
        throw new Error('The push payload is too large.');
    }

    const browserPublicKey = Buffer.from(keys.p256dh, 'base64url');
    const authSecret = Buffer.from(keys.auth, 'base64url');

    if (browserPublicKey.length !== UNCOMPRESSED_KEY_BYTES || authSecret.length !== AUTH_SECRET_BYTES) {
        throw new Error('The browser keys have the wrong size.');
    }

    const senderKeys = createECDH(CURVE_NAME);

    if (overrides.senderPrivateKey === undefined) {
        senderKeys.generateKeys();
    } else {
        senderKeys.setPrivateKey(overrides.senderPrivateKey);
    }

    const senderPublicKey = senderKeys.getPublicKey();
    // computeSecret throws when the browser key is not a point on the curve, so a bad key never encrypts anything.
    const sharedSecret = senderKeys.computeSecret(browserPublicKey);
    const salt = overrides.salt ?? randomBytes(SALT_BYTES);

    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), browserPublicKey, senderPublicKey]);
    const inputKey = expand(sharedSecret, authSecret, keyInfo, 32);
    const keyLabel = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
    const nonceLabel = Buffer.from('Content-Encoding: nonce\0', 'utf8');
    const contentKey = expand(inputKey, salt, keyLabel, 16);
    const nonce = expand(inputKey, salt, nonceLabel, 12);

    const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
    const record = padRecord(payload);
    const encrypted = Buffer.concat([cipher.update(record), cipher.final()]);
    const tag = cipher.getAuthTag();

    const recordSize = Buffer.alloc(4);

    recordSize.writeUInt32BE(RECORD_SIZE);

    const keyIdLength = Buffer.from([senderPublicKey.length]);

    return Buffer.concat([salt, recordSize, keyIdLength, senderPublicKey, encrypted, tag]);
}

// A new P-256 key pair for the VAPID token. The private key leaves this function only as a JWK, for the key file.
function generateVapidKeyPair(): VapidKeyPair {
    const senderKeys = createECDH(CURVE_NAME);

    senderKeys.generateKeys();

    const publicBytes = senderKeys.getPublicKey();
    const privateBytes = senderKeys.getPrivateKey();
    const xBytes = publicBytes.subarray(1, 33);
    const yBytes = publicBytes.subarray(33, 65);
    const privateJwk: JsonWebKey = {
        kty: 'EC',
        crv: 'P-256',
        d: toBase64Url(privateBytes),
        x: toBase64Url(xBytes),
        y: toBase64Url(yBytes),
    };

    return { publicKey: toBase64Url(publicBytes), privateJwk };
}

// The public key as base64url, rebuilt from the JWK, or undefined when the JWK is not a full P-256 key.
function readVapidPublicKey(privateJwk: JsonWebKey): string | undefined {
    const { x: xCoordinate, y: yCoordinate, d: privateValue, kty, crv } = privateJwk;

    if (kty !== 'EC' || crv !== 'P-256' || xCoordinate === undefined || yCoordinate === undefined || privateValue === undefined) {
        return undefined;
    }

    const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(xCoordinate, 'base64url'), Buffer.from(yCoordinate, 'base64url')]);

    return point.length === UNCOMPRESSED_KEY_BYTES ? toBase64Url(point) : undefined;
}

// The value of the Authorization header: a signed token and the public key.
function buildVapidAuthorization(keys: VapidKeyPair, input: VapidTokenInput): string {
    const header = encodeJsonSegment({ typ: 'JWT', alg: 'ES256' });
    const claims = encodeJsonSegment({ aud: input.audience, exp: input.nowSeconds + VAPID_TOKEN_SECONDS, sub: input.subject });
    const signingInput = `${header}.${claims}`;
    const privateKey = createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
    const signingBytes = Buffer.from(signingInput, 'utf8');
    const signature = sign('sha256', signingBytes, { key: privateKey, dsaEncoding: ES256_RAW_SIGNATURE_ENCODING });

    return `vapid t=${signingInput}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

export { MAX_PAYLOAD_BYTES, PADDING_BLOCK_BYTES, buildVapidAuthorization, encryptPushPayload, generateVapidKeyPair, readVapidPublicKey };
export type { BrowserPushKeys, EncryptionOverrides, VapidKeyPair, VapidTokenInput };
