import { describe, expect, it } from 'vitest';

import { buildSetupLink, readServerPort } from './setupLinkUrl.ts';

describe('buildSetupLink', () => {
    it('uses localhost and the port when no public URL is set', () => {
        expect(buildSetupLink('abc', { PORT: '4000' }))
            .toBe('http://localhost:4000/setup?code=abc');
    });

    it('uses localhost on the default port when PORT is not set', () => {
        expect(buildSetupLink('abc', {}))
            .toBe('http://localhost:3000/setup?code=abc');
    });

    it('uses CLOUDBOT_PUBLIC_URL instead of localhost when it is set', () => {
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
