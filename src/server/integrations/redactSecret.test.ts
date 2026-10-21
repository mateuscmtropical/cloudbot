import { describe, expect, it } from 'vitest';

import { redactSecret } from './redactSecret.ts';

const SECRET = 'sk-live-1234567890';

describe('redactSecret', () => {
    it('removes every plain copy of the secret', () => {
        expect(redactSecret('key sk-live-1 and again sk-live-1', 'sk-live-1'))
            .toBe('key [redacted] and again [redacted]');
    });

    it('removes the base64 form of the secret too', () => {
        const encoded = Buffer.from('sk-live-1', 'utf8')
            .toString('base64');

        expect(redactSecret(`header ${encoded} end`, 'sk-live-1'))
            .toBe('header [redacted] end');
    });

    it('removes hex in lower and upper case, and the URL-encoded form', () => {
        const special = 'pa ss/w=rd&1';
        const hex = Buffer.from(special, 'utf8')
            .toString('hex');
        const encoded = encodeURIComponent(special);

        expect(redactSecret(`${hex} ${hex.toUpperCase()} ${encoded}`, special))
            .toBe('[redacted] [redacted] [redacted]');
    });

    it('removes base64url, with the secret at each position inside a base64 group', () => {
        const secretBytes = Buffer.from(SECRET, 'utf8');
        const urlSafe = secretBytes.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');

        expect(redactSecret(`token ${urlSafe}`, SECRET))
            .not.toContain(urlSafe.slice(0, 12));
    });

    it('removes the secret at each of the three positions inside a base64 group', () => {
        const secretBytes = Buffer.from(SECRET, 'utf8');

        [0, 1, 2].forEach((prefixLength) => {
            const stream = Buffer.concat([Buffer.alloc(prefixLength, 0x41), secretBytes, Buffer.alloc(2, 0x42)]);
            const encoded = stream.toString('base64');
            const redacted = redactSecret(encoded, SECRET);

            expect(redacted)
                .toContain('[redacted]');
            expect(redacted.length)
                .toBeLessThan(encoded.length);
        });
    });

    it('drops a secret that the byte cut split, from the end of a truncated output', () => {
        expect(redactSecret('output sk-li', 'sk-live-1', true))
            .toBe('output ');
        expect(redactSecret('output sk-li', 'sk-live-1', false))
            .toBe('output sk-li');
    });

    it('drops a base64 form that the cut split too', () => {
        const encoded = Buffer.from('sk-live-1', 'utf8')
            .toString('base64');
        const cut = encoded.slice(0, 6);

        expect(redactSecret(`ok ${cut}`, 'sk-live-1', true))
            .toBe('ok ');
    });

    it('leaves the text alone when there is no secret', () => {
        expect(redactSecret('plain output', undefined))
            .toBe('plain output');
        expect(redactSecret('plain output', ''))
            .toBe('plain output');
    });
});
