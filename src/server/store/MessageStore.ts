import { randomUUID } from 'node:crypto';

import { and, desc, eq, isNotNull, isNull, lt } from 'drizzle-orm';

import { messages } from './schema.ts';
import type { AppDatabase, ListMessagesOptions, Message, NewMessage, StoreOptions } from './types.ts';

class MessageStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async add(input: NewMessage): Promise<Message> {
        // JSON.stringify returns undefined for values such as undefined or functions.
        const serializedContent = JSON.stringify(input.content) as string | undefined;

        if (serializedContent === undefined) {
            throw new Error(`Message content must be JSON-serializable, got ${typeof input.content}`);
        }

        const newMessage = {
            id: randomUUID(),
            botId: input.botId,
            emailDeliveryId: input.emailDeliveryId ?? null,
            emailTaskHandledAt: null,
            role: input.role,
            kind: input.kind,
            content: input.content,
            createdAt: this.now(),
        };
        const insertedRows = await this.database.insert(messages)
            .values(newMessage)
            .returning();
        const insertedMessage = insertedRows[0];

        if (insertedMessage === undefined) {
            throw new Error('Inserting a message returned no row');
        }

        return insertedMessage;
    }

    async getByEmailDeliveryId(emailDeliveryId: string): Promise<Message | undefined> {
        const deliveryCondition = eq(messages.emailDeliveryId, emailDeliveryId);
        const rows = await this.database.select()
            .from(messages)
            .where(deliveryCondition);

        return rows[0];
    }

    async markEmailTaskHandled(messageId: string): Promise<boolean> {
        const messageCondition = eq(messages.id, messageId);
        const isEmailDelivery = isNotNull(messages.emailDeliveryId);
        const isNotHandled = isNull(messages.emailTaskHandledAt);
        const condition = and(messageCondition, isEmailDelivery, isNotHandled);
        const updatedRows = await this.database.update(messages)
            .set({ emailTaskHandledAt: this.now() })
            .where(condition)
            .returning({ id: messages.id });

        return updatedRows.length > 0;
    }

    async getById(messageId: string): Promise<Message | undefined> {
        const condition = eq(messages.id, messageId);
        const rows = await this.database.select()
            .from(messages)
            .where(condition);

        return rows[0];
    }

    async updateContent(messageId: string, content: unknown): Promise<Message | undefined> {
        const condition = eq(messages.id, messageId);
        const rows = await this.database.update(messages)
            .set({ content })
            .where(condition)
            .returning();

        return rows[0];
    }

    async listByKind(kind: string): Promise<Message[]> {
        const condition = eq(messages.kind, kind);

        return this.database.select()
            .from(messages)
            .where(condition);
    }

    // Returns the newest `limit` messages, oldest first. Pass the `sequence` of
    // the oldest message in the last page as `beforeSequence` to load the page
    // before it.
    async listByBot(botId: string, options: ListMessagesOptions): Promise<Message[]> {
        const botCondition = eq(messages.botId, botId);
        const pageCondition = options.beforeSequence === undefined
            ? undefined
            : lt(messages.sequence, options.beforeSequence);
        const filter = and(botCondition, pageCondition);
        const newestFirst = desc(messages.sequence);
        const rows = await this.database.select()
            .from(messages)
            .where(filter)
            .orderBy(newestFirst)
            .limit(options.limit);

        return rows.reverse();
    }
}

export { MessageStore };
