import type { EmailAccountRecord, EmailAccountSettings, EmailAccountStore, SaveEmailAccountResult } from '../store/EmailAccountStore.ts';
import type { EmailPasswordStore } from './EmailPasswordStore.ts';

// The settings and the password are kept apart. The password never leaves the vault except for a mail operation.
class EmailAccountService {
    private readonly accountStore: Pick<EmailAccountStore, 'get' | 'save'>;
    private readonly passwordStore: Pick<EmailPasswordStore, 'isSet' | 'read' | 'save' | 'remove'>;

    constructor(
        accountStore: Pick<EmailAccountStore, 'get' | 'save'>,
        passwordStore: Pick<EmailPasswordStore, 'isSet' | 'read' | 'save' | 'remove'>,
    ) {
        this.accountStore = accountStore;
        this.passwordStore = passwordStore;
    }

    getAccount(botId: string): Promise<EmailAccountRecord | undefined> {
        return this.accountStore.get(botId);
    }

    // A changed account clears the old password, so a password for another mailbox is never used.
    async saveSettings(botId: string, settings: EmailAccountSettings): Promise<SaveEmailAccountResult> {
        const saved = await this.accountStore.save(botId, settings);

        if (saved.isChanged) {
            this.passwordStore.remove(botId);
        }

        return saved;
    }

    hasPassword(botId: string): boolean {
        return this.passwordStore.isSet(botId);
    }

    readPassword(botId: string): string | undefined {
        return this.passwordStore.read(botId);
    }

    savePassword(botId: string, password: string): void {
        this.passwordStore.save(botId, password);
    }
}

export { EmailAccountService };
