import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';

import type * as schema from './schema.ts';
import type { bots, messages } from './schema.ts';

type Bot = typeof bots.$inferSelect;
type Message = typeof messages.$inferSelect;
type MessageRole = Message['role'];
type AppDatabase = SqliteRemoteDatabase<typeof schema>;

interface BotProfile {
    name: string;
    title: string;
    description: string;
}

interface NewMessage {
    botId: string;
    role: MessageRole;
    kind: string;
    content: unknown;
    emailDeliveryId?: string | undefined;
}

interface ListMessagesOptions {
    limit: number;
    beforeSequence?: number | undefined;
}

interface StoreOptions {
    now?: () => number;
}

export type {
    AppDatabase,
    Bot,
    BotProfile,
    ListMessagesOptions,
    Message,
    MessageRole,
    NewMessage,
    StoreOptions,
};
