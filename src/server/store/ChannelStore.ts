import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import type { MascotColorName, MascotEyes, MascotShape } from '../../shared/mascot.ts';
import { readMascotColor, readMascotEyes, readMascotShape } from '../../shared/mascot.ts';
import type { MessageBody, ChatRole } from '../../shared/chatTypes.ts';
import { channelMembers, channelMessages, channels } from './schema.ts';
import type { AppDatabase, StoreOptions } from './types.ts';

// A problem the owner can read in the chat, such as a manager that cannot leave the channel.
class ChannelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ChannelError';
    }
}

interface ChannelMember {
    botId: string;
    isManager: boolean;
    joinedAt: number;
}

interface Channel {
    id: string;
    name: string;
    createdAt: number;
    members: ChannelMember[];
}

interface NewChannel {
    name: string;
    managerId: string;
    memberIds: string[];
}

// The author is copied into the row, so the history still shows who wrote a message after the bot is deleted.
interface NewChannelMessage {
    authorBotId: string | undefined;
    authorName: string;
    authorColor: MascotColorName;
    authorShape: MascotShape;
    authorEyes: MascotEyes;
    role: ChatRole;
    kind: string;
    body: MessageBody;
}

interface ChannelMessage extends NewChannelMessage {
    id: string;
    channelId: string;
    sequence: number;
    createdAt: number;
}

const CHANNEL_NAME_MAX_LENGTH = 40;

class ChannelStore {
    private readonly database: AppDatabase;
    private readonly now: () => number;

    constructor(database: AppDatabase, options: StoreOptions = {}) {
        this.database = database;
        this.now = options.now ?? (() => Date.now());
    }

    async create(newChannel: NewChannel): Promise<Channel> {
        const name = newChannel.name.trim();

        if (name === '' || name.length > CHANNEL_NAME_MAX_LENGTH || /[\r\n]/.test(name)) {
            throw new ChannelError(`A channel name must be one line of 1 to ${String(CHANNEL_NAME_MAX_LENGTH)} characters.`);
        }

        if (!newChannel.memberIds.includes(newChannel.managerId)) {
            throw new ChannelError('The manager must be one of the channel members.');
        }

        if (await this.findByName(name) !== undefined) {
            throw new ChannelError(`A channel named ${name} already exists.`);
        }

        const channelId = randomUUID();
        const createdAt = this.now();
        const memberRows = newChannel.memberIds.map(botId => ({ channelId, botId, isManager: botId === newChannel.managerId, joinedAt: createdAt }));

        // The unique index on the name also catches two creates that race past the check above.
        try {
            await this.database.insert(channels)
                .values({ id: channelId, name, createdAt });
        } catch (error: unknown) {
            // Drizzle wraps the SQLite error, so the original text is in the cause.
            if (error instanceof Error && `${error.message} ${String(error.cause)}`.includes('UNIQUE constraint failed')) {
                throw new ChannelError(`A channel named ${name} already exists.`);
            }

            throw error;
        }

        // A transaction is not used here. The database connection is shared, so two transactions at once fail.
        // A failed member insert removes the channel row again, so no channel is left without its members.
        try {
            await this.database.insert(channelMembers)
                .values(memberRows);
        } catch (error: unknown) {
            const match = eq(channels.id, channelId);

            await this.database.delete(channels)
                .where(match);

            throw error;
        }

        const created = await this.getById(channelId);

        if (created === undefined) {
            throw new Error('Inserting a channel returned no row');
        }

        return created;
    }

    async getById(channelId: string): Promise<Channel | undefined> {
        const match = eq(channels.id, channelId);
        const rows = await this.database.select()
            .from(channels)
            .where(match)
            .limit(1);
        const channel = rows[0];

        if (channel === undefined) {
            return undefined;
        }

        return { ...channel, members: await this.membersOf(channelId) };
    }

    // Names are compared without case, so "Project" and "project" are one channel.
    async findByName(name: string): Promise<Channel | undefined> {
        const rows = await this.database.select()
            .from(channels)
            .where(sql`lower(${channels.name}) = lower(${name.trim()})`)
            .limit(1);
        const channel = rows[0];

        if (channel === undefined) {
            return undefined;
        }

        return { ...channel, members: await this.membersOf(channel.id) };
    }

    async list(): Promise<Channel[]> {
        const order = asc(channels.createdAt);
        const rows = await this.database.select()
            .from(channels)
            .orderBy(order);
        const withMembers = rows.map(async channel => ({ ...channel, members: await this.membersOf(channel.id) }));

        return Promise.all(withMembers);
    }

    // The names of the channels where this bot is the manager. A bot that manages one cannot be deleted.
    async managedChannelNames(botId: string): Promise<string[]> {
        const sameChannel = eq(channels.id, channelMembers.channelId);
        const sameBot = eq(channelMembers.botId, botId);
        const isManager = eq(channelMembers.isManager, true);
        const managesChannel = and(sameBot, isManager);
        const rows = await this.database.select({ name: channels.name })
            .from(channelMembers)
            .innerJoin(channels, sameChannel)
            .where(managesChannel);

        return rows.map(row => row.name);
    }

    async addMember(channelId: string, botId: string): Promise<void> {
        const members = await this.membersOf(channelId);

        if (members.some(member => member.botId === botId)) {
            throw new ChannelError('That bot is already in the channel.');
        }

        await this.database.insert(channelMembers)
            .values({ channelId, botId, isManager: false, joinedAt: this.now() });
    }

    // The manager stays until another member takes the role, so the channel always has someone to split requests.
    async removeMember(channelId: string, botId: string): Promise<void> {
        const member = (await this.membersOf(channelId)).find(candidate => candidate.botId === botId);

        if (member === undefined) {
            throw new ChannelError('That bot is not in the channel.');
        }

        if (member.isManager) {
            throw new ChannelError('The manager cannot leave the channel. Make another member the manager first.');
        }

        const inChannel = eq(channelMembers.channelId, channelId);
        const isBot = eq(channelMembers.botId, botId);
        const thisMember = and(inChannel, isBot);

        await this.database.delete(channelMembers)
            .where(thisMember);
    }

    async setManager(channelId: string, botId: string): Promise<void> {
        const members = await this.membersOf(channelId);

        if (!members.some(member => member.botId === botId)) {
            throw new ChannelError('The new manager must be a member of the channel.');
        }

        // One statement sets every member at once, so there is never a moment with two managers or none.
        const isNewManager = sql`${channelMembers.botId} = ${botId}`;
        const inChannel = eq(channelMembers.channelId, channelId);

        await this.database.update(channelMembers)
            .set({ isManager: isNewManager })
            .where(inChannel);
    }

    // Deleting the channel removes its messages too. The owner asks for this in the chat and approves it.
    async deleteChannel(channelId: string): Promise<void> {
        const match = eq(channels.id, channelId);

        await this.database.delete(channels)
            .where(match);
    }

    async appendMessage(channelId: string, message: NewChannelMessage): Promise<ChannelMessage> {
        const id = randomUUID();
        const createdAt = this.now();
        const rows = await this.database.insert(channelMessages)
            .values({
                id,
                channelId,
                authorBotId: message.authorBotId,
                authorName: message.authorName,
                authorColor: message.authorColor,
                authorShape: message.authorShape,
                authorEyes: message.authorEyes,
                role: message.role,
                kind: message.kind,
                content: message.body,
                createdAt,
            })
            .returning();
        const row = rows[0];

        if (row === undefined) {
            throw new Error('Inserting a channel message returned no row');
        }

        return {
            id,
            channelId,
            sequence: row.sequence,
            createdAt,
            authorBotId: message.authorBotId,
            authorName: message.authorName,
            authorColor: message.authorColor,
            authorShape: message.authorShape,
            authorEyes: message.authorEyes,
            role: message.role,
            kind: message.kind,
            body: message.body,
        };
    }

    // The newest messages, oldest first, as the transcript the manager reads.
    async listRecentMessages(channelId: string, limit: number): Promise<ChannelMessage[]> {
        const inChannel = eq(channelMessages.channelId, channelId);
        const newestFirst = desc(channelMessages.sequence);
        const rows = await this.database.select()
            .from(channelMessages)
            .where(inChannel)
            .orderBy(newestFirst)
            .limit(limit);

        return rows
            .map(row => ({
                id: row.id,
                channelId: row.channelId,
                sequence: row.sequence,
                createdAt: row.createdAt,
                authorBotId: row.authorBotId ?? undefined,
                authorName: row.authorName,
                authorColor: readMascotColor(row.authorColor),
                authorShape: readMascotShape(row.authorShape),
                authorEyes: readMascotEyes(row.authorEyes),
                role: row.role,
                kind: row.kind,
                body: row.content,
            }))
            .reverse();
    }

    private async membersOf(channelId: string): Promise<ChannelMember[]> {
        const inChannel = eq(channelMembers.channelId, channelId);
        const managerFirst = desc(channelMembers.isManager);
        const oldestJoinFirst = asc(channelMembers.joinedAt);
        const rows = await this.database.select()
            .from(channelMembers)
            .where(inChannel)
            .orderBy(managerFirst, oldestJoinFirst);

        return rows.map(row => ({ botId: row.botId, isManager: row.isManager, joinedAt: row.joinedAt }));
    }
}

export { CHANNEL_NAME_MAX_LENGTH, ChannelError, ChannelStore };
export type { Channel, ChannelMember, ChannelMessage, NewChannel, NewChannelMessage };
