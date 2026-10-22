import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { matchesWhatsAppVerifyToken, verifyWhatsAppSignature } from './whatsappSignature.ts';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const BODY = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }), 'utf8');

function sign(body: Uint8Array, secret = APP_SECRET): string {
    const digest = createHmac('sha256', secret)
        .update(body)
        .digest('hex');

    return `sha256=${digest}`;
}

describe('verifyWhatsAppSignature', () => {
    it('accepts the signature Meta makes for the exact body', () => {
        expect(verifyWhatsAppSignature(BODY, sign(BODY), APP_SECRET))
            .toBe(true);
    });

    it('accepts upper case hex and surrounding spaces in the header', () => {
        const digest = createHmac('sha256', APP_SECRET)
            .update(BODY)
            .digest('hex')
            .toUpperCase();
        const header = ` sha256=${digest} `;

        expect(verifyWhatsAppSignature(BODY, header, APP_SECRET))
            .toBe(true);
    });

    it('refuses a missing, malformed or prefixed header', () => {
        expect(verifyWhatsAppSignature(BODY, undefined, APP_SECRET))
            .toBe(false);
        expect(verifyWhatsAppSignature(BODY, '', APP_SECRET))
            .toBe(false);
        expect(verifyWhatsAppSignature(BODY, 'sha256=1234', APP_SECRET))
            .toBe(false);
        expect(verifyWhatsAppSignature(BODY, sign(BODY)
            .replace('sha256=', 'sha1='), APP_SECRET))
            .toBe(false);
        expect(verifyWhatsAppSignature(BODY, sign(BODY)
            .replace('sha256=', 'sha256=00'), APP_SECRET))
            .toBe(false);
    });

    it('refuses another body or another secret', () => {
        const changedBody = Buffer.from(`${BODY.toString('utf8')} `, 'utf8');

        expect(verifyWhatsAppSignature(changedBody, sign(BODY), APP_SECRET))
            .toBe(false);
        expect(verifyWhatsAppSignature(BODY, sign(BODY), 'fedcba9876543210fedcba9876543210'))
            .toBe(false);
    });
});

describe('matchesWhatsAppVerifyToken', () => {
    it('matches only the same token', () => {
        expect(matchesWhatsAppVerifyToken('my-token', 'my-token'))
            .toBe(true);
        expect(matchesWhatsAppVerifyToken('my-token', 'my-token '))
            .toBe(false);
        expect(matchesWhatsAppVerifyToken('', 'my-token'))
            .toBe(false);
    });
});
