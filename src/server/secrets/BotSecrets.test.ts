import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vault } from '../vault/Vault.ts';
import { BotSecretError, BotSecrets, buildVaultName, parseSecretSite } from './BotSecrets.ts';

describe('parseSecretSite', () => {
    it('keeps only the https origin', () => {
        expect(parseSecretSite('https://github.com/login?next=/'))
            .toBe('https://github.com');
    });

    it('refuses http, other schemes and text that is not a URL', () => {
        expect(() => parseSecretSite('http://github.com'))
            .toThrow('must use https');
        expect(() => parseSecretSite('javascript:alert(1)'))
            .toThrow(BotSecretError);
        expect(() => parseSecretSite('github.com'))
            .toThrow('full https address');
    });
});

describe('buildVaultName', () => {
    it('gives each bot its own vault name that the vault accepts', () => {
        const firstName = buildVaultName('bot-one', 'GITHUB_PASSWORD');
        const secondName = buildVaultName('bot-two', 'GITHUB_PASSWORD');

        expect(firstName)
            .toMatch(/^BOT_[0-9A-F]{12}_GITHUB_PASSWORD$/);
        expect(firstName).not.toBe(secondName);
    });
});

describe('BotSecrets', () => {
    let folderPath: string;

    beforeEach(() => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-bot-secrets-'));
    });

    afterEach(() => {
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('saves a value with its site and reads it back for the same bot only', () => {
        const secrets = new BotSecrets(new Vault(folderPath));

        secrets.save('bot-one', 'GITHUB_PASSWORD', 'https://github.com/login', 'fake-password-1');

        expect(secrets.read('bot-one', 'GITHUB_PASSWORD'))
            .toEqual({ site: 'https://github.com', value: 'fake-password-1' });
        expect(secrets.read('bot-two', 'GITHUB_PASSWORD'))
            .toBeUndefined();
    });

    it('keeps the value encrypted on disk', () => {
        const secrets = new BotSecrets(new Vault(folderPath));

        secrets.save('bot-one', 'CARD_NUMBER', 'https://shop.example', 'fake-card-4242');

        const vaultText = readFileSync(join(folderPath, 'vault.json'), 'utf8');

        expect(vaultText).not.toContain('fake-card-4242');
    });

    it('refuses a name the model got wrong', () => {
        const secrets = new BotSecrets(new Vault(folderPath));

        expect(() => {
            secrets.save('bot-one', 'github password', 'https://github.com', 'x');
        })
            .toThrow('not valid');
        expect(secrets.read('bot-one', '../ANTHROPIC_API_KEY'))
            .toBeUndefined();
    });

    it('refuses names that could pass for the Claude setup', () => {
        const secrets = new BotSecrets(new Vault(folderPath));

        expect(() => {
            secrets.save('bot-one', 'ANTHROPIC_API_KEY', 'https://console.anthropic.com', 'x');
        })
            .toThrow('belong to CloudBot');
        expect(() => {
            secrets.save('bot-one', 'CLAUDE_CODE_OAUTH_TOKEN', 'https://claude.ai', 'x');
        })
            .toThrow('belong to CloudBot');
    });
});
