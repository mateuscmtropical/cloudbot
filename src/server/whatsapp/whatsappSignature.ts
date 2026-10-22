import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{64}$/i;

// Meta sends `X-Hub-Signature-256: sha256=<hex>`, an HMAC of the exact body with the app secret.
function verifyWhatsAppSignature(rawBody: Uint8Array, signatureHeader: string | undefined, appSecret: string): boolean {
    const header = (signatureHeader ?? '').trim();

    if (!header.startsWith(SIGNATURE_PREFIX)) {
        return false;
    }

    const providedHex = header.slice(SIGNATURE_PREFIX.length);

    if (!SIGNATURE_HEX_PATTERN.test(providedHex)) {
        return false;
    }

    const expected = createHmac('sha256', appSecret)
        .update(rawBody)
        .digest();
    const provided = Buffer.from(providedHex, 'hex');

    return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// The GET handshake compares a token that Meta sends in the query. The digests have one fixed length, so the
// comparison does not reveal the token's length or where a wrong token differs.
function matchesWhatsAppVerifyToken(provided: string, expected: string): boolean {
    const providedDigest = createHash('sha256')
        .update(provided)
        .digest();
    const expectedDigest = createHash('sha256')
        .update(expected)
        .digest();

    return timingSafeEqual(providedDigest, expectedDigest);
}

export { matchesWhatsAppVerifyToken, verifyWhatsAppSignature };
