import { asc, eq, lt } from 'drizzle-orm';

import { whatsappConnections, whatsappMessages } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

type WhatsAppConnectionRecord = typeof whatsappConnections.$inferSelect;
type WhatsAppMessageRecord = typeof whatsappMessages.$inferSelect;

interface WhatsAppLinkedResult {
    status: 'linked';
    connection: WhatsAppConnectionRecord;
    isNew: boolean;
}

interface WhatsAppPhoneTakenResult {
    status: 'phone-taken';
}

interface WhatsAppBotLinkedResult {
    status: 'bot-linked';
    phoneNumberId: string;
}

type WhatsAppLinkResult = WhatsAppLinkedResult | WhatsAppPhoneTakenResult | WhatsAppBotLinkedResult;

// The phone number each bot receives from and the message ids Meta already delivered. Secrets stay in the vault.
class WhatsAppStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async list(): Promise<WhatsAppConnectionRecord[]> {
        const createdOrder = asc(whatsappConnections.createdAt);
        const phoneOrder = asc(whatsappConnections.phoneNumberId);

        return this.database.select()
            .from(whatsappConnections)
            .orderBy(createdOrder, phoneOrder);
    }

    async findByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppConnectionRecord | undefined> {
        const phoneCondition = eq(whatsappConnections.phoneNumberId, phoneNumberId);
        const foundRows = await this.database.select()
            .from(whatsappConnections)
            .where(phoneCondition);

        return foundRows[0];
    }

    async findByBotId(botId: string): Promise<WhatsAppConnectionRecord | undefined> {
        const botCondition = eq(whatsappConnections.botId, botId);
        const foundRows = await this.database.select()
            .from(whatsappConnections)
            .where(botCondition);

        return foundRows[0];
    }

    // A bot keeps one number and a number keeps one bot. Linking the same pair again changes nothing.
    async link(botId: string, phoneNumberId: string): Promise<WhatsAppLinkResult> {
        const existingPhone = await this.findByPhoneNumberId(phoneNumberId);

        if (existingPhone !== undefined) {
            return existingPhone.botId === botId
                ? { status: 'linked', connection: existingPhone, isNew: false }
                : { status: 'phone-taken' };
        }

        const existingBot = await this.findByBotId(botId);

        if (existingBot !== undefined) {
            return { status: 'bot-linked', phoneNumberId: existingBot.phoneNumberId };
        }

        const insertedRows = await this.database.insert(whatsappConnections)
            .values({ phoneNumberId, botId, createdAt: this.now() })
            .onConflictDoNothing()
            .returning();
        const inserted = insertedRows[0];

        if (inserted !== undefined) {
            return { status: 'linked', connection: inserted, isNew: true };
        }

        // Another call may have saved the same number or the same bot between the reads above.
        const racedPhone = await this.findByPhoneNumberId(phoneNumberId);

        if (racedPhone !== undefined && racedPhone.botId === botId) {
            return { status: 'linked', connection: racedPhone, isNew: false };
        }

        if (racedPhone !== undefined) {
            return { status: 'phone-taken' };
        }

        const racedBot = await this.findByBotId(botId);

        if (racedBot !== undefined) {
            return { status: 'bot-linked', phoneNumberId: racedBot.phoneNumberId };
        }

        throw new Error('The WhatsApp link was not saved.');
    }

    // Returns false when the bot has no WhatsApp connection.
    async unlink(botId: string): Promise<boolean> {
        const botCondition = eq(whatsappConnections.botId, botId);
        const removedRows = await this.database.delete(whatsappConnections)
            .where(botCondition)
            .returning();

        return removedRows.length > 0;
    }

    // Takes the message id before its side effect. False means Meta already delivered it.
    async claimMessage(messageId: string, botId: string): Promise<boolean> {
        const insertedRows = await this.database.insert(whatsappMessages)
            .values({ messageId, botId, receivedAt: this.now() })
            .onConflictDoNothing()
            .returning();

        return insertedRows.length > 0;
    }

    // Gives a claim back, so a retry can handle the message after a failure.
    async releaseMessage(messageId: string): Promise<void> {
        const messageCondition = eq(whatsappMessages.messageId, messageId);

        await this.database.delete(whatsappMessages)
            .where(messageCondition);
    }

    // Removes the ids older than the cutoff. Returns how many rows went.
    async removeOldMessages(cutoff: number): Promise<number> {
        const oldCondition = lt(whatsappMessages.receivedAt, cutoff);
        const removedRows = await this.database.delete(whatsappMessages)
            .where(oldCondition)
            .returning({ messageId: whatsappMessages.messageId });

        return removedRows.length;
    }
}

export { WhatsAppStore };
export type {
    WhatsAppBotLinkedResult,
    WhatsAppConnectionRecord,
    WhatsAppLinkResult,
    WhatsAppLinkedResult,
    WhatsAppMessageRecord,
    WhatsAppPhoneTakenResult,
};
