import { describe, expect, it } from 'vitest';

import { PROJECT_URL, readPushSubject } from './readPushSubject.ts';

describe('readPushSubject', () => {
    it('uses the https origin of the public address', () => {
        expect(readPushSubject({ CLOUDBOT_PUBLIC_URL: 'https://bot.example.com/setup?code=abc' }))
            .toBe('https://bot.example.com');
    });

    it.each([
        ['no public address', {}],
        ['an http address', { CLOUDBOT_PUBLIC_URL: 'http://localhost:3100' }],
        ['text that is not an address', { CLOUDBOT_PUBLIC_URL: 'nonsense' }],
    ])('falls back to the project page for %s', (_label, environment) => {
        expect(readPushSubject(environment))
            .toBe(PROJECT_URL);
    });
});
