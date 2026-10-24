import { describe, expect, it } from 'vitest';

import { isBitwardenSecretName, isServerOnlySecretName } from './serverOnlySecretNames.ts';

describe('isServerOnlySecretName', () => {
    it('reserves the sign-in grants and the Bitwarden account', () => {
        expect(isServerOnlySecretName('OAUTH_GOOGLE_CLIENT'))
            .toBe(true);
        expect(isServerOnlySecretName('OAUTH_NOTION_1A2B'))
            .toBe(true);
        expect(isServerOnlySecretName('BITWARDEN_ACCOUNT'))
            .toBe(true);
        expect(isServerOnlySecretName('BITWARDEN_ANYTHING'))
            .toBe(true);
    });

    it('leaves the names the bot asks for', () => {
        expect(isServerOnlySecretName('GITHUB_PASSWORD'))
            .toBe(false);
        expect(isServerOnlySecretName('MY_BITWARDEN_NOTE'))
            .toBe(false);
        expect(isServerOnlySecretName('OAUTH'))
            .toBe(false);
    });
});

describe('isBitwardenSecretName', () => {
    it('names only the Bitwarden prefix', () => {
        expect(isBitwardenSecretName('BITWARDEN_ACCOUNT'))
            .toBe(true);
        expect(isBitwardenSecretName('OAUTH_GOOGLE_CLIENT'))
            .toBe(false);
    });
});
