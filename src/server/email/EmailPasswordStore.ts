import { buildVaultName } from '../secrets/BotSecrets.ts';
import type { Vault } from '../vault/Vault.ts';

// The same name the setup form uses. It is a vault name with the bot prefix, not a site secret. It starts with an
// underscore, which no bot secret name can, so a secret the bot asks for can never replace or remove it.
const EMAIL_PASSWORD_SECRET_NAME = '_EMAIL_PASSWORD';
const MAX_EMAIL_PASSWORD_LENGTH = 1024;

class EmailPasswordStore {
    private readonly vault: Vault;

    constructor(vault: Vault) {
        this.vault = vault;
    }

    isSet(botId: string): boolean {
        const vaultName = buildVaultName(botId, EMAIL_PASSWORD_SECRET_NAME);

        return this.vault.has(vaultName);
    }

    read(botId: string): string | undefined {
        const vaultName = buildVaultName(botId, EMAIL_PASSWORD_SECRET_NAME);

        return this.vault.get(vaultName);
    }

    save(botId: string, password: string): void {
        if (password.length === 0) {
            throw new Error('The mailbox password cannot be empty.');
        }

        if (password.length > MAX_EMAIL_PASSWORD_LENGTH) {
            throw new Error('The mailbox password is too long.');
        }

        const vaultName = buildVaultName(botId, EMAIL_PASSWORD_SECRET_NAME);

        this.vault.set(vaultName, password);
    }

    remove(botId: string): void {
        const vaultName = buildVaultName(botId, EMAIL_PASSWORD_SECRET_NAME);

        this.vault.delete(vaultName);
    }
}

export { EMAIL_PASSWORD_SECRET_NAME, MAX_EMAIL_PASSWORD_LENGTH, EmailPasswordStore };
