import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_PAYLOAD_BYTES, PADDING_BLOCK_BYTES, buildVapidAuthorization, encryptPushPayload, generateVapidKeyPair, readVapidPublicKey } from './webPushCrypto.ts';

// Fixed keys and salt, and the body that the http_ece library 1.2.0 makes from them with 470 bytes of padding, which fills
// the record to 512 bytes. It is a separate implementation of the same RFC.
const KNOWN_PLAINTEXT = 'When I grow up, I want to be a watermelon';
const KNOWN_SENDER_PRIVATE_KEY = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const KNOWN_BROWSER_PUBLIC_KEY = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const KNOWN_AUTH_SECRET = 'BTBZMqHGzbgBYEQMQYb4HQ';
const KNOWN_SALT = 'DGv6ra1nlYgDCS1FRnbzlw';
const KNOWN_BODY = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A9goaJ859fWXyy9AWgvAIl0zrgh2DBskdaSAWF9N5z8qcGwGAE9Rc_Yo2zPjGX5OwFa8AsnkEdsn1MdefnzYECUHkYK7U2CZn3VfJgeVTCBiMe7GbrOtvpvSLseES2X_LJQ-AmB_NJFDPU2xx0Avhoc-EWWA4_yTkCkumZ-mrOUxXhLm6G_JT-Puat03ewW5gsIpLVFL9iJM5V1Zz4q2Q3GVE3HPJ8zKPixBpm4Mrcw1e8jP2GzYy41rlwr76Yc0-9ckeN9hEputRjXzsvzqo1u9SvDPbkoUsefg8PF4VrMWI-KXaE4AzZOG889H8KI25Bnu2q8fFoCebGIwl3MzAnXhf_aT2i6Xvpk_r3WjR9FAz9RODDYSEzZEUUudn0jce_HFBHdYgGtIHHI2kK38cG9e6d70GlPVUlbCnbxJpWnbSgX9n4pBTF4otlNK4WfKvfXvMPN7lSIvg6x_CMnAL8RVyFZ132exiVnSeH9I2JyCei5Q5GVnTRNdERTfaC0Roc7Wi6ZbCtXKprNFzZkXZJ15Sv2fc9KDd57hoLVGVE4Yp5UmTSgF9FbyI-7BbernXvEGAk_skaZTCyNVmeyhM4a3RAeKauxJuas4QCLcUGsI8eybny6pZRN0D_1nI91ocsBGMSIoLKzeIADv0lWdpMYlcujuRtHeqjSzfwHqR3LeBvXPQrONzlJl9re2kLqhdc';

// A receiver written from the RFC steps, to check that a body made with random keys can be read by a browser.
function decryptAsBrowser(body: Buffer, browserPrivateKey: Buffer, browserPublicKey: Buffer, authSecret: Buffer): string {
    const salt = body.subarray(0, 16);
    const keyIdLength = body.readUInt8(20);
    const senderPublicKey = body.subarray(21, 21 + keyIdLength);
    const encrypted = body.subarray(21 + keyIdLength);
    const browserKeys = createECDH('prime256v1');

    browserKeys.setPrivateKey(browserPrivateKey);

    const sharedSecret = browserKeys.computeSecret(senderPublicKey);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browserPublicKey, senderPublicKey]);
    const inputKey = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
    const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);

    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));

    const record = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);

    // RFC 8188: the padding is zero bytes after the delimiter, and the last non zero byte is the delimiter.
    const delimiterIndex = record.findLastIndex(byte => byte !== 0);

    expect(record[delimiterIndex])
        .toBe(2);

    return record.subarray(0, delimiterIndex)
        .toString('utf8');
}

interface TestBrowserKeys {
    privateKey: Buffer;
    publicKey: Buffer;
    authSecret: Buffer;
    encoded: { p256dh: string; auth: string };
}

function createBrowserKeys(): TestBrowserKeys {
    const browserKeys = createECDH('prime256v1');

    browserKeys.generateKeys();

    const authSecret = Buffer.alloc(16, 7);
    const publicKey = browserKeys.getPublicKey();

    return {
        privateKey: browserKeys.getPrivateKey(),
        publicKey,
        authSecret,
        encoded: { p256dh: publicKey.toString('base64url'), auth: authSecret.toString('base64url') },
    };
}

describe('encryptPushPayload', () => {
    it('matches the body of an independent implementation for fixed keys', () => {
        const body = encryptPushPayload(Buffer.from(KNOWN_PLAINTEXT, 'utf8'), { p256dh: KNOWN_BROWSER_PUBLIC_KEY, auth: KNOWN_AUTH_SECRET }, {
            salt: Buffer.from(KNOWN_SALT, 'base64url'),
            senderPrivateKey: Buffer.from(KNOWN_SENDER_PRIVATE_KEY, 'base64url'),
        });

        expect(body.toString('base64url'))
            .toBe(KNOWN_BODY);
    });

    it('makes a body the browser can decrypt, with new keys and a new salt each time', () => {
        const browserKeys = createECDH('prime256v1');

        browserKeys.generateKeys();

        const authSecret = Buffer.alloc(16, 7);
        const keys = { p256dh: browserKeys.getPublicKey()
            .toString('base64url'), auth: authSecret.toString('base64url') };
        const first = encryptPushPayload(Buffer.from('{"title":"Ana"}'), keys);
        const second = encryptPushPayload(Buffer.from('{"title":"Ana"}'), keys);

        expect(decryptAsBrowser(first, browserKeys.getPrivateKey(), browserKeys.getPublicKey(), authSecret))
            .toBe('{"title":"Ana"}');
        expect(first.equals(second))
            .toBe(false);
    });

    it('refuses a payload that does not fit in one record', () => {
        const browserKeys = createECDH('prime256v1');

        browserKeys.generateKeys();

        const keys = { p256dh: browserKeys.getPublicKey()
            .toString('base64url'), auth: Buffer.alloc(16)
            .toString('base64url') };

        expect(() => encryptPushPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), keys))
            .toThrow('too large');
        expect(() => encryptPushPayload(Buffer.alloc(MAX_PAYLOAD_BYTES), keys))
            .not.toThrow();
    });

    it('keeps the largest body inside the 4096 bytes that push services accept', () => {
        const keys = createBrowserKeys();
        const body = encryptPushPayload(Buffer.alloc(MAX_PAYLOAD_BYTES), keys.encoded);

        expect(MAX_PAYLOAD_BYTES)
            .toBe(4096 - 86 - 17);
        expect(body.length)
            .toBe(4096);
    });

    it.each([0, 1, 40, 200, 400, 511])('gives a payload of %i bytes a body of the same fixed size', (length) => {
        const keys = createBrowserKeys();
        const body = encryptPushPayload(Buffer.alloc(length, 65), keys.encoded);

        // 86 bytes of header, 512 bytes of padded record and 16 bytes of tag.
        expect(body.length)
            .toBe(86 + PADDING_BLOCK_BYTES + 16);
        expect(decryptAsBrowser(body, keys.privateKey, keys.publicKey, keys.authSecret))
            .toBe('A'.repeat(length));
    });

    it('pads a larger payload to the next multiple of 512 bytes', () => {
        const keys = createBrowserKeys();
        const body = encryptPushPayload(Buffer.alloc(512, 65), keys.encoded);

        expect(body.length)
            .toBe(86 + 2 * PADDING_BLOCK_BYTES + 16);
    });

    it('refuses browser keys of the wrong size or off the curve', () => {
        const goodAuth = Buffer.alloc(16)
            .toString('base64url');
        const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])
            .toString('base64url');

        expect(() => encryptPushPayload(Buffer.from('x'), { p256dh: 'AAAA', auth: goodAuth }))
            .toThrow('wrong size');
        expect(() => encryptPushPayload(Buffer.from('x'), { p256dh: offCurve, auth: goodAuth }))
            .toThrow();
    });
});

describe('buildVapidAuthorization', () => {
    it('signs a token that the public key verifies, with the audience, expiry and subject', () => {
        const keys = generateVapidKeyPair();
        const header = buildVapidAuthorization(keys, { audience: 'https://fcm.googleapis.com', subject: 'https://example.com', nowSeconds: 1_000 });
        const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);

        expect(match)
            .not.toBeNull();

        const [, headerPart, claimsPart, signaturePart, publicKey] = match ?? [];
        const claims = JSON.parse(Buffer.from(claimsPart ?? '', 'base64url')
            .toString('utf8')) as Record<string, unknown>;
        const publicBytes = Buffer.from(publicKey ?? '', 'base64url');
        const verifyKey = createPublicKey({
            key: { kty: 'EC', crv: 'P-256', x: publicBytes.subarray(1, 33)
                .toString('base64url'), y: publicBytes.subarray(33, 65)
                .toString('base64url') },
            format: 'jwk',
        });
        const isValid = verify('sha256', Buffer.from(`${headerPart ?? ''}.${claimsPart ?? ''}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signaturePart ?? '', 'base64url'));

        expect(isValid)
            .toBe(true);
        expect(publicKey)
            .toBe(keys.publicKey);
        expect(claims)
            .toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_000 + 12 * 60 * 60, sub: 'https://example.com' });
    });
});

describe('readVapidPublicKey', () => {
    it('rebuilds the public key of a stored private key', () => {
        const keys = generateVapidKeyPair();

        expect(readVapidPublicKey(keys.privateJwk))
            .toBe(keys.publicKey);
    });

    it('returns undefined for a key that is not a full P-256 key', () => {
        expect(readVapidPublicKey({ kty: 'EC', crv: 'P-256', x: 'abc' }))
            .toBeUndefined();
        expect(readVapidPublicKey({ kty: 'RSA' }))
            .toBeUndefined();
    });
});
