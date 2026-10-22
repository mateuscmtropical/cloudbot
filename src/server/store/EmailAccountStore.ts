import { and, asc, eq, isNull } from 'drizzle-orm';

import { emailAccounts, emailDeliveries } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type EmailAccountRecord = typeof emailAccounts.$inferSelect;
type EmailDeliveryRecord = typeof emailDeliveries.$inferSelect;

interface EmailAccountSettings {
    address: string;
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    username: string;
}

interface EmailCursor {
    uidValidity: string | null;
    lastUid: number | null;
}

interface SaveEmailAccountResult {
    account: EmailAccountRecord;
    // True when the settings were new or changed. The cursor and the deliveries were cleared then.
    isChanged: boolean;
}

function hasSameSettings(account: EmailAccountRecord, settings: EmailAccountSettings): boolean {
    return account.address === settings.address
        && account.imapHost === settings.imapHost
        && account.imapPort === settings.imapPort
        && account.smtpHost === settings.smtpHost
        && account.smtpPort === settings.smtpPort
        && account.smtpSecure === settings.smtpSecure
        && account.username === settings.username;
}

class EmailAccountStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(): Promise<EmailAccountRecord[]> {
        const createdOrder = asc(emailAccounts.createdAt);

        return this.database.select()
            .from(emailAccounts)
            .orderBy(createdOrder);
    }

    async get(botId: string): Promise<EmailAccountRecord | undefined> {
        const botCondition = eq(emailAccounts.botId, botId);
        const foundRows = await this.database.select()
            .from(emailAccounts)
            .where(botCondition);

        return foundRows[0];
    }

    // A new or changed account starts at the current mailbox position and without old deliveries.
    // Saving the same settings keeps the cursor, so the password form can be filled again safely.
    async save(botId: string, settings: EmailAccountSettings): Promise<SaveEmailAccountResult> {
        const existing = await this.get(botId);
        const isChanged = existing === undefined || !hasSameSettings(existing, settings);
        const now = this.now();
        const uidValidity = isChanged ? null : existing.uidValidity;
        const lastUid = isChanged ? null : existing.lastUid;
        const createdAt = existing?.createdAt ?? now;
        const newAccount = {
            botId,
            ...settings,
            uidValidity,
            lastUid,
            createdAt,
            updatedAt: now,
        };
        const insertedRows = await this.database.insert(emailAccounts)
            .values(newAccount)
            .onConflictDoUpdate({
                target: emailAccounts.botId,
                set: {
                    address: settings.address,
                    imapHost: settings.imapHost,
                    imapPort: settings.imapPort,
                    smtpHost: settings.smtpHost,
                    smtpPort: settings.smtpPort,
                    smtpSecure: settings.smtpSecure,
                    username: settings.username,
                    uidValidity,
                    lastUid,
                    updatedAt: now,
                },
            })
            .returning();
        const account = insertedRows[0];

        if (account === undefined) {
            throw new Error('Saving an email account returned no row');
        }

        if (isChanged) {
            await this.clearDeliveries(botId);
        }

        return { account, isChanged };
    }

    // Records the first position of a mailbox or the position after UIDVALIDITY changed.
    // The expected cursor is part of the condition, so a settings change during a poll wins.
    async setBaseline(botId: string, previous: EmailCursor, uidValidity: string, lastUid: number): Promise<boolean> {
        const botCondition = eq(emailAccounts.botId, botId);
        const validityCondition = previous.uidValidity === null
            ? isNull(emailAccounts.uidValidity)
            : eq(emailAccounts.uidValidity, previous.uidValidity);
        const uidCondition = previous.lastUid === null
            ? isNull(emailAccounts.lastUid)
            : eq(emailAccounts.lastUid, previous.lastUid);
        const condition = and(botCondition, validityCondition, uidCondition);
        const updatedRows = await this.database.update(emailAccounts)
            .set({ uidValidity, lastUid })
            .where(condition)
            .returning({ botId: emailAccounts.botId });

        if (updatedRows.length === 0) {
            return false;
        }

        // The UIDs of the old mailbox mean nothing in the new one.
        if (previous.uidValidity !== null) {
            await this.clearDeliveries(botId);
        }

        return true;
    }

    // Moves the position after a mail was handled. False when the account settings changed during the poll.
    async advanceCursor(botId: string, uidValidity: string, uid: number): Promise<boolean> {
        const botCondition = eq(emailAccounts.botId, botId);
        const validityCondition = eq(emailAccounts.uidValidity, uidValidity);
        const condition = and(botCondition, validityCondition);
        const updatedRows = await this.database.update(emailAccounts)
            .set({ lastUid: uid })
            .where(condition)
            .returning({ botId: emailAccounts.botId });

        return updatedRows.length > 0;
    }

    // Takes one mail for delivery. False when the mail was already claimed, also in an earlier run.
    async claimDelivery(botId: string, uidValidity: string, uid: number): Promise<boolean> {
        const claimedRows = await this.database.insert(emailDeliveries)
            .values({ botId, uidValidity, uid, claimedAt: this.now() })
            .onConflictDoNothing()
            .returning({ uid: emailDeliveries.uid });

        return claimedRows.length > 0;
    }

    async getDelivery(botId: string, uidValidity: string, uid: number): Promise<EmailDeliveryRecord | undefined> {
        const botCondition = eq(emailDeliveries.botId, botId);
        const validityCondition = eq(emailDeliveries.uidValidity, uidValidity);
        const uidCondition = eq(emailDeliveries.uid, uid);
        const deliveryCondition = and(botCondition, validityCondition, uidCondition);
        const rows = await this.database.select()
            .from(emailDeliveries)
            .where(deliveryCondition);

        return rows[0];
    }

    async markDeliveryHandled(botId: string, uidValidity: string, uid: number): Promise<boolean> {
        const botCondition = eq(emailDeliveries.botId, botId);
        const validityCondition = eq(emailDeliveries.uidValidity, uidValidity);
        const uidCondition = eq(emailDeliveries.uid, uid);
        const deliveryCondition = and(botCondition, validityCondition, uidCondition);
        const updatedRows = await this.database.update(emailDeliveries)
            .set({ handledAt: this.now() })
            .where(deliveryCondition)
            .returning({ uid: emailDeliveries.uid });

        return updatedRows.length > 0;
    }

    // Gives a claim back when the message could not be queued, so the next poll tries it again.
    async releaseDelivery(botId: string, uidValidity: string, uid: number): Promise<void> {
        const botCondition = eq(emailDeliveries.botId, botId);
        const validityCondition = eq(emailDeliveries.uidValidity, uidValidity);
        const uidCondition = eq(emailDeliveries.uid, uid);
        const deliveryCondition = and(botCondition, validityCondition, uidCondition);

        await this.database.delete(emailDeliveries)
            .where(deliveryCondition);
    }

    async clearDeliveries(botId: string): Promise<void> {
        const botCondition = eq(emailDeliveries.botId, botId);

        await this.database.delete(emailDeliveries)
            .where(botCondition);
    }
}

export { EmailAccountStore };
export type { EmailAccountRecord, EmailAccountSettings, EmailCursor, EmailDeliveryRecord, SaveEmailAccountResult };
