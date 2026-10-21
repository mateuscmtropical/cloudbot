import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { RoutineSchedule } from '../routines/schedule.ts';

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
    // Routine turns pick the routines model. Rows from before this column were chat turns.
    source: text('source', { enum: ['chat', 'routine', 'webhook'] })
        .notNull()
        .default('chat'),
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

// Rules the owner sets for a bot. Block rules may also name tools the SDK must refuse.
const botRules = sqliteTable('bot_rules', {
    id: text('id')
        .primaryKey(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['allow', 'block'] })
        .notNull(),
    text: text('text')
        .notNull(),
    blockedTools: text('blocked_tools', { mode: 'json' })
        .$type<string[]>()
        .notNull(),
    createdAt: integer('created_at')
        .notNull(),
}, table => [
    index('bot_rules_bot_id')
        .on(table.botId),
]);

// A prompt a bot gets on a schedule. `nextRunAt` is in milliseconds since the epoch.
const routines = sqliteTable('routines', {
    id: text('id')
        .primaryKey(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name')
        .notNull(),
    prompt: text('prompt')
        .notNull(),
    schedule: text('schedule', { mode: 'json' })
        .$type<RoutineSchedule>()
        .notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' })
        .notNull(),
    nextRunAt: integer('next_run_at')
        .notNull(),
    lastRunAt: integer('last_run_at'),
    createdAt: integer('created_at')
        .notNull(),
}, table => [
    index('routines_bot_id')
        .on(table.botId),
]);

// A URL that wakes a bot. Only the SHA-256 hash of the token is stored, so the URL is shown once, at creation.
const webhooks = sqliteTable('webhooks', {
    id: text('id')
        .primaryKey(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name')
        .notNull(),
    tokenHash: text('token_hash')
        .notNull()
        .unique(),
    createdAt: integer('created_at')
        .notNull(),
}, table => [
    index('webhooks_bot_id')
        .on(table.botId),
]);

// A page the bot checks on a schedule. Only a hash of the visible text is kept, plus the last text for the diff.
// `lastText` is capped in size. `textHash` is null until the first check sets the baseline.
const watches = sqliteTable('watches', {
    id: text('id')
        .primaryKey(),
    botId: text('bot_id')
        .notNull()
        .references(() => bots.id, { onDelete: 'cascade' }),
    name: text('name')
        .notNull(),
    url: text('url')
        .notNull(),
    intervalMinutes: integer('interval_minutes')
        .notNull(),
    keyword: text('keyword'),
    textHash: text('text_hash'),
    lastText: text('last_text'),
    nextCheckAt: integer('next_check_at')
        .notNull(),
    lastCheckedAt: integer('last_checked_at'),
    createdAt: integer('created_at')
        .notNull(),
}, table => [
    index('watches_bot_id')
        .on(table.botId),
]);

// The model the owner chose for each kind of work. A null column means the CLI default,
// or no helper agent for browsing and documents.
const botModels = sqliteTable('bot_models', {
    botId: text('bot_id')
        .primaryKey()
        .references(() => bots.id, { onDelete: 'cascade' }),
    chatModel: text('chat_model'),
    routinesModel: text('routines_model'),
    reviewModel: text('review_model'),
    browsingModel: text('browsing_model'),
    documentsModel: text('documents_model'),
    // The effort per kind of work, as a level of the SDK effort option. A null column is the CLI default.
    chatEffort: text('chat_effort'),
    routinesEffort: text('routines_effort'),
    reviewEffort: text('review_effort'),
    browsingEffort: text('browsing_effort'),
    documentsEffort: text('documents_effort'),
});

// The time, spending and step limits per turn, for chat turns and for routine, webhook and watch turns.
// A null column means no limit of that kind.
const botLimits = sqliteTable('bot_limits', {
    botId: text('bot_id')
        .primaryKey()
        .references(() => bots.id, { onDelete: 'cascade' }),
    chatMinutes: integer('chat_minutes'),
    chatUsd: real('chat_usd'),
    chatSteps: integer('chat_steps'),
    routineMinutes: integer('routine_minutes'),
    routineUsd: real('routine_usd'),
    routineSteps: integer('routine_steps'),
});

export { botLimits, botModels, botRules, bots, messages, routines, settings, turnQueue, turnWaits, watches, webhooks };
export type { StoredUploadRecord };
