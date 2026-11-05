import { createHmac, timingSafeEqual } from 'node:crypto';

type ReadHeader = (name: string) => string | undefined;
type SignatureCheck = (secret: string, readHeader: ReadHeader, body: Buffer, now: number) => boolean;

// Stripe and Slack sign a time with the body. An older signature is refused, so a caught call cannot be sent again later.
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

function hmac(secret: string, data: Buffer | string, encoding: 'hex' | 'base64'): string {
    const signer = createHmac('sha256', secret);

    signer.update(data);

    return signer.digest(encoding);
}

// Compares in constant time, so the time of the answer says nothing about the expected value.
function isSameText(given: string | undefined, expected: string): boolean {
    if (given === undefined) {
        return false;
    }

    const givenBytes = Buffer.from(given);
    const expectedBytes = Buffer.from(expected);

    return givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);
}

function isRecent(seconds: string | undefined, now: number): boolean {
    const time = Number(seconds) * 1000;

    return Number.isFinite(time) && Math.abs(now - time) <= MAX_SIGNATURE_AGE_MS;
}

function readStripeParts(header: string): Map<string, string[]> {
    const pairs = header.split(',');

    return pairs.reduce((parts, pair) => {
        const [key = '', value = ''] = pair.trim()
            .split('=', 2);
        const known = parts.get(key) ?? [];

        parts.set(key, [...known, value]);

        return parts;
    }, new Map<string, string[]>());
}

function checkStripe(secret: string, readHeader: ReadHeader, body: Buffer, now: number): boolean {
    const parts = readStripeParts(readHeader('stripe-signature') ?? '');
    const time = parts.get('t')?.[0];
    const signatures = parts.get('v1') ?? [];

    if (time === undefined || !isRecent(time, now)) {
        return false;
    }

    const signed = Buffer.concat([Buffer.from(`${time}.`), body]);
    const expected = hmac(secret, signed, 'hex');

    return signatures.some(signature => isSameText(signature, expected));
}

function checkSlack(secret: string, readHeader: ReadHeader, body: Buffer, now: number): boolean {
    const time = readHeader('x-slack-request-timestamp');

    if (time === undefined || !isRecent(time, now)) {
        return false;
    }

    const signed = Buffer.concat([Buffer.from(`v0:${time}:`), body]);
    const expected = `v0=${hmac(secret, signed, 'hex')}`;
    const given = readHeader('x-slack-signature');

    return isSameText(given, expected);
}

// GitHub, Shopify and Linear sign the body alone, each in its own header and encoding.
function bodyCheck(header: string, encoding: 'hex' | 'base64', prefix = ''): SignatureCheck {
    return (secret, readHeader, body) => {
        const given = readHeader(header);
        const expected = `${prefix}${hmac(secret, body, encoding)}`;

        return isSameText(given, expected);
    };
}

// GitLab sends the secret itself instead of a signature.
function checkGitlab(secret: string, readHeader: ReadHeader): boolean {
    const given = readHeader('x-gitlab-token');

    return isSameText(given, secret);
}

// How each provider signs a call, from its documentation. The names match SIGNED_WEBHOOK_PROVIDERS.
const SIGNATURE_CHECKS: Record<string, SignatureCheck> = {
    github: bodyCheck('x-hub-signature-256', 'hex', 'sha256='),
    gitlab: checkGitlab,
    stripe: checkStripe,
    slack: checkSlack,
    shopify: bodyCheck('x-shopify-hmac-sha256', 'base64'),
    linear: bodyCheck('linear-signature', 'hex'),
};
const SIGNED_PROVIDERS = Object.keys(SIGNATURE_CHECKS);

function checkWebhookSignature(provider: string, secret: string, readHeader: ReadHeader, body: Buffer, now: number): boolean {
    const check = SIGNATURE_CHECKS[provider];

    return check !== undefined && check(secret, readHeader, body, now);
}

export { MAX_SIGNATURE_AGE_MS, SIGNED_PROVIDERS, checkWebhookSignature };
