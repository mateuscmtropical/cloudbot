import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { BitwardenStatus } from '../../shared/bitwarden.ts';
import { BitwardenCli } from './BitwardenCli.ts';
import type { BitwardenAccount, BitwardenField, BitwardenLoginItem } from './BitwardenCli.ts';
import type { BitwardenAccountStore } from './bitwardenAccount.ts';

type BitwardenAccounts = Pick<BitwardenAccountStore, 'read' | 'save' | 'forget'>;

interface BitwardenVaultOptions {
    accounts: BitwardenAccounts;
    // The folder that holds one folder of bw state for each bot. Only the server user can open it.
    baseDir: string;
    // Tests inject a fake Bitwarden CLI here.
    createCli?: (account: BitwardenAccount, appDataDir: string) => BitwardenCli;
    now?: () => number;
}

interface CliEntry {
    cli: BitwardenCli;
    // Tells whether the saved account changed, so a new save starts a new CLI.
    accountKey: string;
}

const FOLDER_TAG_LENGTH = 16;
const FOLDER_MODE = 0o700;
// The owner approves one login on one site, and the approval covers its user name, password and code for this long.
const APPROVAL_MS = 10 * 60 * 1000;

// The folder name is a hash of the bot id, so the bot id is not in the file system and each bot keeps its own sign-in.
function folderNameFor(botId: string): string {
    const botHash = createHash('sha256')
        .update(botId)
        .digest('hex');

    return botHash.slice(0, FOLDER_TAG_LENGTH);
}

function approvalKey(botId: string, itemId: string, origin: string): string {
    return JSON.stringify([botId, itemId, origin]);
}

// The Bitwarden accounts of the bots. It keeps the account in the vault, one CLI for each bot with its session in memory,
// and the owner's approvals for a login on a site. It is the only code that reads the account.
class BitwardenVault {
    private readonly accounts: BitwardenAccounts;
    private readonly baseDir: string;
    private readonly createCli: (account: BitwardenAccount, appDataDir: string) => BitwardenCli;
    private readonly now: () => number;
    private readonly entries = new Map<string, CliEntry>();
    private readonly approvals = new Map<string, number>();

    constructor(options: BitwardenVaultOptions) {
        this.accounts = options.accounts;
        this.baseDir = options.baseDir;
        this.createCli = options.createCli ?? ((account, appDataDir) => new BitwardenCli({ account, appDataDir }));
        this.now = options.now ?? Date.now;
    }

    isConfigured(botId: string): boolean {
        return this.accounts.read(botId) !== undefined;
    }

    status(botId: string): BitwardenStatus {
        const account = this.accounts.read(botId);

        return { configured: account !== undefined, serverUrl: account?.serverUrl ?? '' };
    }

    // A new account replaces the old one, so the old sign-in is closed first.
    async save(botId: string, account: BitwardenAccount): Promise<void> {
        await this.closeSession(botId);
        this.accounts.save(botId, account);
    }

    // Signs out, deletes the vault secret and the folder of bw, and forgets the approvals.
    async forget(botId: string): Promise<void> {
        await this.closeSession(botId);
        this.accounts.forget(botId);
        this.dropApprovals(botId);
    }

    // The connection test: sign in, unlock and sync.
    async test(botId: string): Promise<void> {
        await this.requireCli(botId)
            .unlock();
    }

    async listLogins(botId: string): Promise<BitwardenLoginItem[]> {
        return this.requireCli(botId)
            .listLogins();
    }

    async getValue(botId: string, itemId: string, field: BitwardenField): Promise<string> {
        return this.requireCli(botId)
            .getValue(itemId, field);
    }

    hasApproval(botId: string, itemId: string, origin: string): boolean {
        const key = approvalKey(botId, itemId, origin);
        const expiresAt = this.approvals.get(key);

        if (expiresAt === undefined) {
            return false;
        }

        if (expiresAt <= this.now()) {
            this.approvals.delete(key);

            return false;
        }

        return true;
    }

    rememberApproval(botId: string, itemId: string, origin: string): void {
        const key = approvalKey(botId, itemId, origin);

        this.approvals.set(key, this.now() + APPROVAL_MS);
    }

    private requireCli(botId: string): BitwardenCli {
        const account = this.accounts.read(botId);

        if (account === undefined) {
            throw new Error('Bitwarden is not set up for this bot.');
        }

        const accountKey = JSON.stringify(account);
        const known = this.entries.get(botId);

        if (known?.accountKey === accountKey) {
            return known.cli;
        }

        const appDataDir = this.prepareFolder(botId);
        const cli = this.createCli(account, appDataDir);

        this.entries.set(botId, { cli, accountKey });

        return cli;
    }

    private folderFor(botId: string): string {
        const name = folderNameFor(botId);

        return join(this.baseDir, name);
    }

    // chmod after mkdir, because the process umask can take bits away from the mode of mkdir.
    private prepareFolder(botId: string): string {
        const folder = this.folderFor(botId);

        mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
        chmodSync(folder, FOLDER_MODE);

        return folder;
    }

    private async closeSession(botId: string): Promise<void> {
        const account = this.accounts.read(botId);
        const known = this.entries.get(botId);

        this.entries.delete(botId);

        if (account !== undefined) {
            const appDataDir = this.prepareFolder(botId);
            const cli = known?.cli ?? this.createCli(account, appDataDir);

            await cli.logout();
        }

        const folder = this.folderFor(botId);

        rmSync(folder, { recursive: true, force: true });
    }

    private dropApprovals(botId: string): void {
        const botPart = JSON.stringify([botId]);
        const prefix = `${botPart.slice(0, -1)},`;

        [...this.approvals.keys()]
            .filter(key => key.startsWith(prefix))
            .forEach((key) => {
                this.approvals.delete(key);
            });
    }
}

export { APPROVAL_MS, BitwardenVault };
export type { BitwardenVaultOptions };
