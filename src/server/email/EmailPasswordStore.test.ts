import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vault } from '../vault/Vault.ts';
import { buildVaultName } from '../secrets/BotSecrets.ts';
import { EmailPasswordStore } from './EmailPasswordStore.ts';

describe('EmailPasswordStore', () => {
    let folderPath: string;
    let store: EmailPasswordStore;

    beforeEach(() => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-email-password-'));
        store = new EmailPasswordStore(new Vault(folderPath));
    });

    afterEach(() => {
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('keeps the password encrypted in the bot vault', () => {
        const password = 'mailbox-password-secret';

        store.save('bot-one', password);

        expect(store.isSet('bot-one'))
            .toBe(true);
        expect(store.read('bot-one'))
            .toBe(password);
        expect(store.read('bot-two'))
            .toBeUndefined();
        expect(readFileSync(join(folderPath, 'vault.json'), 'utf8'))
            .not.toContain(password);
        expect(buildVaultName('bot-one', '_EMAIL_PASSWORD'))
            .toMatch(/^BOT_[0-9A-F]{12}__EMAIL_PASSWORD$/);
    });

    it('refuses an empty or oversized password and can remove the saved value', () => {
        const saveEmptyPassword = (): void => {
            store.save('bot-one', '');
        };
        const saveOversizedPassword = (): void => {
            store.save('bot-one', 'x'.repeat(1025));
        };

        expect(saveEmptyPassword)
            .toThrow('cannot be empty');
        expect(saveOversizedPassword)
            .toThrow('too long');

        store.save('bot-one', 'valid-password');
        store.remove('bot-one');

        expect(store.isSet('bot-one'))
            .toBe(false);
    });
});
