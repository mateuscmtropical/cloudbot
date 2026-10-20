import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Vault } from './Vault.ts';

describe('Vault', () => {
    let folderPath: string;

    beforeEach(() => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-vault-'));
    });

    afterEach(() => {
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('returns the stored value after the vault is opened again', () => {
        const firstVault = new Vault(folderPath);

        firstVault.set('ANTHROPIC_API_KEY', 'sk-ant-test');

        const reopenedVault = new Vault(folderPath);

        expect(reopenedVault.get('ANTHROPIC_API_KEY'))
            .toBe('sk-ant-test');
    });

    it('lists, checks and deletes secrets', () => {
        const vault = new Vault(folderPath);

        vault.set('FIRST_SECRET', 'one');
        vault.set('SECOND_SECRET', 'two');
        vault.delete('FIRST_SECRET');

        expect(vault.listNames())
            .toEqual(['SECOND_SECRET']);
        expect(vault.has('SECOND_SECRET'))
            .toBe(true);
        expect(vault.has('FIRST_SECRET'))
            .toBe(false);
        expect(vault.get('FIRST_SECRET'))
            .toBeUndefined();
    });

    it('does not write the secret value in plain text', () => {
        const vault = new Vault(folderPath);

        vault.set('ANTHROPIC_API_KEY', 'sk-ant-plain-text-marker');

        const fileContent = readFileSync(join(folderPath, 'vault.json'), 'utf8');

        expect(fileContent)
            .not.toContain('sk-ant-plain-text-marker');
    });

    it('uses a fresh IV for each stored value', () => {
        const vault = new Vault(folderPath);

        vault.set('FIRST_SECRET', 'same value');
        vault.set('SECOND_SECRET', 'same value');

        const fileContent = readFileSync(join(folderPath, 'vault.json'), 'utf8');
        const parsedFile = JSON.parse(fileContent) as { secrets: Record<string, { iv: string }> };

        expect(parsedFile.secrets.FIRST_SECRET?.iv)
            .not.toBe(parsedFile.secrets.SECOND_SECRET?.iv);
    });

    it('fails to decrypt when the key file is replaced', () => {
        const vault = new Vault(folderPath);

        vault.set('ANTHROPIC_API_KEY', 'sk-ant-test');
        writeFileSync(join(folderPath, 'vault.key'), randomBytes(32));

        const vaultWithOtherKey = new Vault(folderPath);

        expect(() => vaultWithOtherKey.get('ANTHROPIC_API_KEY'))
            .toThrow();
    });

    it('rejects an empty name', () => {
        const vault = new Vault(folderPath);

        expect(() => {
            vault.set('', 'value');
        })
            .toThrow('Secret name cannot be empty.');
    });

    it('rejects an empty value', () => {
        const vault = new Vault(folderPath);

        expect(() => {
            vault.set('ANTHROPIC_API_KEY', '');
        })
            .toThrow('Secret value cannot be empty.');
    });
});
