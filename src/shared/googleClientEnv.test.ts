import { describe, expect, it } from 'vitest';

import { readGoogleClientEnv } from './googleClientEnv.ts';

describe('readGoogleClientEnv', () => {
    it('reads both lines and trims them', () => {
        expect(readGoogleClientEnv({ CLOUDBOT_GOOGLE_CLIENT_ID: ' id ', CLOUDBOT_GOOGLE_CLIENT_SECRET: ' secret ' }))
            .toEqual({ clientId: 'id', clientSecret: 'secret' });
    });

    it('answers undefined when neither line is set or both are empty', () => {
        expect(readGoogleClientEnv({}))
            .toBeUndefined();
        expect(readGoogleClientEnv({ CLOUDBOT_GOOGLE_CLIENT_ID: '', CLOUDBOT_GOOGLE_CLIENT_SECRET: '  ' }))
            .toBeUndefined();
    });

    it('refuses a client with only one line', () => {
        expect(() => readGoogleClientEnv({ CLOUDBOT_GOOGLE_CLIENT_SECRET: 'secret' }))
            .toThrow('Set both or neither');
        expect(() => readGoogleClientEnv({ CLOUDBOT_GOOGLE_CLIENT_ID: 'id' }))
            .toThrow('Set both or neither');
    });
});
