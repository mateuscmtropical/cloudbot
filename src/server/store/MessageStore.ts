import { randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';

import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '../../shared/searchTypes.ts';
import type { MessageSearchHit } from '../../shared/searchTypes.ts';
import { messages } from './schema.ts';
import type { AppDatabase, ListMessagesOptions, Message, NewMessage, StoreOptions } from './types.ts';

const SNIPPET_WORDS = 16;

// Each word becomes a quoted prefix, so nothing the owner types can be read as search syntax.
function toMatchQuery(text: string): string {
    const words = text.replace(/\p{Cc}/gu, ' ')
        .split(/\s+/)
        .filter(word => word !== '');
    const phrases = words.map(word => `"${word.replaceAll('"', '""')}"*`);

    return phrases.join(' ');
}

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

    // Only the messages of this bot are removed, so a wrong id cannot touch another conversation.
    async removeMany(botId: string, messageIds: string[]): Promise<void> {
        const botCondition = eq(messages.botId, botId);
        const idCondition = inArray(messages.id, messageIds);
        const removeCondition = and(botCondition, idCondition);

        await this.database.delete(messages)
            .where(removeCondition);
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

    // Newest match first. Every word must match, and the last letters of a word may be missing, so results show while typing.
    async search(text: string, limit: number): Promise<MessageSearchHit[]> {
        const matchQuery = toMatchQuery(text);

        if (matchQuery === '') {
            return [];
        }

        const snippet = sql<string>`snippet(messages_fts, 0, ${SNIPPET_MARK_START}, ${SNIPPET_MARK_END}, '…', ${SNIPPET_WORDS})`;
        const newestFirst = desc(messages.sequence);

        return this.database.select({
            botId: messages.botId,
            messageId: messages.id,
            sequence: messages.sequence,
            createdAt: messages.createdAt,
            snippet,
        })
            .from(messages)
            .innerJoin(sql`messages_fts`, sql`messages_fts.rowid = ${messages.sequence}`)
            .where(sql`messages_fts MATCH ${matchQuery}`)
            .orderBy(newestFirst)
            .limit(limit);
    }
}

export { MessageStore };
