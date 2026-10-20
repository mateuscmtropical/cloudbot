import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { MESSAGE_ROLES } from './messageRoles.ts';

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

export { bots, messages, settings };
