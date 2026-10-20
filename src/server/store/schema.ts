import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { MESSAGE_ROLES } from './messageRoles.ts';

// The file facts a queued turn needs. The bytes are read back from absolutePath after a restart.
interface StoredUploadRecord {
    id: string;
    name: string;
    absolutePath: string;
    mimeType: string;
    sizeBytes: number;
}

const bots = sqliteTable('bots', {
    id: text('id')
        .primaryKey(),
    name: text('name')
        .notNull(),
    title: text('title')
        .notNull(),
    description: text('description')
        .notNull(),
    sessionId: text('session_id'),
    createdAt: integer('created_at')
        .notNull(),
});

// `sequence` is the insertion order and the paging cursor. AUTOINCREMENT keeps
// it increasing even if the newest row is ever deleted.
const messages = sqliteTable('messages', {
    sequence: integer('sequence')
        .primaryKey({ autoIncrement: true }),
    id: text('id')
        .notNull()
        .unique(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MESSAGE_ROLES })
        .notNull(),
    kind: text('kind')
        .notNull(),
    content: text('content', { mode: 'json' })
        .notNull(),
    createdAt: integer('created_at')
        .notNull(),
}, table => [
    index('messages_bot_id')
        .on(table.botId),
]);

const settings = sqliteTable('settings', {
    key: text('key')
        .primaryKey(),
    value: text('value')
        .notNull(),
});

// Messages waiting for a turn. Lower positions run first, so a resumed turn goes in front.
const turnQueue = sqliteTable('turn_queue', {
    id: text('id')
        .primaryKey(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    position: integer('position')
        .notNull(),
    // The stored user message this turn answers. Null for a "Continue." turn.
    messageId: text('message_id'),
    text: text('text')
        .notNull(),
    uploads: text('uploads', { mode: 'json' })
        .$type<StoredUploadRecord[]>()
        .notNull(),
}, table => [
    index('turn_queue_bot_id')
        .on(table.botId),
]);

// The time a bot's queue resumes after a usage limit. A row exists only while the bot waits.
const turnWaits = sqliteTable('turn_waits', {
    botId: text('bot_id')
        .primaryKey()
        .references(() => bots.id, { onDelete: 'cascade' }),
    resumeAt: integer('resume_at')
        .notNull(),
});

export { bots, messages, settings, turnQueue, turnWaits };
export type { StoredUploadRecord };
