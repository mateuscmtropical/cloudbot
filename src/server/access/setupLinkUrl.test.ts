import { describe, expect, it } from 'vitest';

import { buildSetupLink, readServerHost, readServerPort } from './setupLinkUrl.ts';

describe('buildSetupLink', () => {
    it('uses the address the server listens on and the port when no public URL is set', () => {
        expect(buildSetupLink('abc', { PORT: '4000' }))
            .toBe('http://127.0.0.1:4000/setup?code=abc');
    });

    it('uses the default address and port when PORT and HOST are not set', () => {
        expect(buildSetupLink('abc', {}))
            .toBe('http://127.0.0.1:3000/setup?code=abc');
    });

    it('uses HOST when it names one interface', () => {
        expect(buildSetupLink('abc', { HOST: '192.168.0.5' }))
            .toBe('http://192.168.0.5:3000/setup?code=abc');
        expect(buildSetupLink('abc', { HOST: '::1' }))
            .toBe('http://[::1]:3000/setup?code=abc');
    });

    it('falls back to localhost when HOST is a wildcard address', () => {
        expect(buildSetupLink('abc', { HOST: '0.0.0.0' }))
            .toBe('http://localhost:3000/setup?code=abc');
        expect(buildSetupLink('abc', { HOST: '::' }))
            .toBe('http://localhost:3000/setup?code=abc');
    });

    it('uses CLOUDBOT_PUBLIC_URL instead of the local address when it is set', () => {
        expect(buildSetupLink('abc', { PORT: '4000', CLOUDBOT_PUBLIC_URL: 'https://bot.example.com' }))
            .toBe('https://bot.example.com/setup?code=abc');
    });

    it('drops trailing slashes from CLOUDBOT_PUBLIC_URL', () => {
        expect(buildSetupLink('abc', { CLOUDBOT_PUBLIC_URL: 'https://bot.example.com//' }))
            .toBe('https://bot.example.com/setup?code=abc');
    });
});

describe('readServerPort', () => {
    it('falls back to 3000 when PORT is not a number', () => {
        expect(readServerPort({ PORT: 'abc' }))
            .toBe(3000);
    });
});

describe('readServerHost', () => {
    it('listens on this machine only when HOST is not set', () => {
        expect(readServerHost({}))
            .toBe('127.0.0.1');
    });

    it('keeps the default for an empty HOST', () => {
        expect(readServerHost({ HOST: '  ' }))
            .toBe('127.0.0.1');
    });

    it('uses HOST when the owner sets it on purpose', () => {
        expect(readServerHost({ HOST: '0.0.0.0' }))
            .toBe('0.0.0.0');
    });
});
