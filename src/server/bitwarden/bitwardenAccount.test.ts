import { describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { isServerOnlySecretName } from '../secrets/serverOnlySecretNames.ts';
import { BITWARDEN_ACCOUNT_SECRET_NAME, BitwardenAccountStore, checkBitwardenAccount, normalizeServerUrl } from './bitwardenAccount.ts';

const GOOD_INPUT = {
    serverUrl: ' https://vault.bitwarden.eu/ ',
    clientId: 'user.11111111-2222-3333-4444-555555555555',
    clientSecret: ' fakeclientsecret0123456789 ',
    masterPassword: ' fake master password ',
};

describe('checkBitwardenAccount', () => {
    it('trims the address and the API key and keeps the master password exactly', () => {
        expect(checkBitwardenAccount(GOOD_INPUT))
            .toEqual({
                ok: true,
                account: {
                    serverUrl: 'https://vault.bitwarden.eu',
                    clientId: 'user.11111111-2222-3333-4444-555555555555',
                    clientSecret: 'fakeclientsecret0123456789',
                    masterPassword: ' fake master password ',
                },
            });
    });

    it('uses the Bitwarden cloud when no address is given', () => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, serverUrl: undefined });

        expect(checked)
            .toMatchObject({ ok: true, account: { serverUrl: 'https://vault.bitwarden.com' } });
    });

    it('keeps the path of a server that lives under one', () => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, serverUrl: 'https://example.com/vault/' });

        expect(checked)
            .toMatchObject({ ok: true, account: { serverUrl: 'https://example.com/vault' } });
    });

    it.each([
        ['http://vault.example.com'],
        ['ftp://vault.example.com'],
        ['vault.example.com'],
        ['https://user:pass@vault.example.com'],
        ['https://vault.example.com/?a=1'],
        ['https://vault.example.com/#x'],
        [`https://example.com/${'a'.repeat(300)}`],
    ])('refuses the address %s', (serverUrl) => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, serverUrl });

        expect(checked.ok)
            .toBe(false);
        expect(JSON.stringify(checked))
            .toContain('https address');
    });

    it.each([
        ['user.not-a-uuid'],
        ['11111111-2222-3333-4444-555555555555'],
        ['organization.11111111-2222-3333-4444-555555555555'],
        [''],
    ])('refuses the client ID %s', (clientId) => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, clientId });

        expect(checked.ok)
            .toBe(false);
        expect(JSON.stringify(checked))
            .toContain('client ID');
    });

    it.each([
        ['short'],
        ['has space 0123456789abcdef'],
        ['a'.repeat(65)],
        [''],
    ])('refuses the client secret %s', (clientSecret) => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, clientSecret });

        expect(checked.ok)
            .toBe(false);
        expect(JSON.stringify(checked))
            .toContain('client secret');
    });

    it('refuses an empty, a too long or a null character master password', () => {
        expect(checkBitwardenAccount({ ...GOOD_INPUT, masterPassword: '' }))
            .toMatchObject({ ok: false });
        expect(checkBitwardenAccount({ ...GOOD_INPUT, masterPassword: 'a'.repeat(1025) }))
            .toMatchObject({ ok: false });
        expect(checkBitwardenAccount({ ...GOOD_INPUT, masterPassword: 'a\0b' }))
            .toMatchObject({ ok: false });
        expect(checkBitwardenAccount({ ...GOOD_INPUT, masterPassword: 42 }))
            .toMatchObject({ ok: false });
    });

    it('never puts a secret in a refusal', () => {
        const checked = checkBitwardenAccount({ ...GOOD_INPUT, clientId: 'bad', masterPassword: 'fake master password' });

        expect(JSON.stringify(checked)).not.toContain('fake master password');
        expect(JSON.stringify(checked)).not.toContain('fakeclientsecret');
    });
});

describe('normalizeServerUrl', () => {
    it('drops a trailing slash', () => {
        expect(normalizeServerUrl('https://vault.bitwarden.com/'))
            .toBe('https://vault.bitwarden.com');
    });
});

describe('BitwardenAccountStore', () => {
    function createStore(): { store: BitwardenAccountStore; saved: Map<string, BotSecret> } {
        const saved = new Map<string, BotSecret>();
        const store = new BitwardenAccountStore({
            read: (botId, name) => saved.get(`${botId}:${name}`),
            save: (botId, name, site, value) => {
                saved.set(`${botId}:${name}`, { site, value });
            },
            remove: (botId, name) => {
                saved.delete(`${botId}:${name}`);
            },
        });

        return { store, saved };
    }

    it('keeps the account under a name no model can read, for the origin of the server', () => {
        const { store, saved } = createStore();
        const checked = checkBitwardenAccount(GOOD_INPUT);

        if (!checked.ok) {
            throw new Error('The input should be valid.');
        }

        store.save('bot-1', checked.account);

        expect(isServerOnlySecretName(BITWARDEN_ACCOUNT_SECRET_NAME))
            .toBe(true);
        expect(BITWARDEN_ACCOUNT_SECRET_NAME)
            .toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
        expect(saved.get(`bot-1:${BITWARDEN_ACCOUNT_SECRET_NAME}`)?.site)
            .toBe('https://vault.bitwarden.eu');
        expect(store.read('bot-1'))
            .toEqual(checked.account);
        expect(store.read('bot-2'))
            .toBeUndefined();

        store.forget('bot-1');

        expect(store.read('bot-1'))
            .toBeUndefined();
    });

    it('ignores a stored value that is not a valid account', () => {
        const { store, saved } = createStore();

        saved.set(`bot-1:${BITWARDEN_ACCOUNT_SECRET_NAME}`, { site: 'https://x.example', value: 'not json' });
        saved.set(`bot-2:${BITWARDEN_ACCOUNT_SECRET_NAME}`, { site: 'https://x.example', value: '{"clientId":"bad"}' });

        expect(store.read('bot-1'))
            .toBeUndefined();
        expect(store.read('bot-2'))
            .toBeUndefined();
    });
});
