import { Hono } from 'hono';
import { z } from 'zod/v4';

import type { ChannelDetail, ChannelMemberView, ChannelPostView, ChannelSummary } from '../../shared/channelTypes.ts';
import type { ChatService } from '../chat/ChatService.ts';
import { respondWithStoredFile } from '../files/storedFileResponse.ts';
import type { BotStore } from '../store/BotStore.ts';
import type { Channel, ChannelMessage, ChannelStore } from '../store/ChannelStore.ts';
import type { Bot } from '../store/types.ts';
import { createOwnerChannel, deleteChannel, updateOwnerChannel } from './channelCommands.ts';
import type { ChannelCommandDeps } from './channelCommands.ts';

interface ChannelRoutesOptions {
    channels: ChannelStore;
    bots: BotStore;
    // Starts the bot turns of a channel round, and stops them. Without it posts are stored but nothing answers.
    rounds?: Pick<ChatService, 'startChannelRound' | 'stopChannelRound' | 'hasActiveChannelRound' | 'findChannelFile' | 'dropChannelMember' | 'endChannelRounds'> | undefined;
}

interface ChannelErrorResponse {
    error: string;
}

const CHANNEL_NOT_FOUND: ChannelErrorResponse = { error: 'No channel has this id.' };
const NO_CHANNEL_FILE: ChannelErrorResponse = { error: 'This post has no file.' };
const EMPTY_TEXT: ChannelErrorResponse = { error: 'Send a non-empty "text" string.' };
// The longest post the owner can send to a channel. A longer one would fill the prompt of every bot that reads it.
const MAX_OWNER_POST_LENGTH = 4000;
const TOO_LONG: ChannelErrorResponse = { error: `A post can have at most ${String(MAX_OWNER_POST_LENGTH)} characters.` };
// The newest messages the channel view loads. Older ones are not shown yet.
const RECENT_MESSAGE_LIMIT = 100;
// The owner's posts have no mascot. The row still needs a color and shape, so these are fixed.
const OWNER_NAME = 'You';
const OWNER_COLOR = 'blue';
const OWNER_SHAPE = 'puff';
const OWNER_EYES = 'smile';
const BAD_SETTINGS: ChannelErrorResponse = { error: 'Send a name, the member ids, a manager id and whether the group is isolated.' };
const BOT_ID_SHAPE = z.string();
const SETTINGS_SHAPE = z.object({
    name: z.string(),
    memberIds: z.array(BOT_ID_SHAPE)
        .min(1),
    managerId: z.string(),
    isIsolated: z.boolean(),
});

// The owner calls them groups. The same store and commands also answer the bots, which call them channels.
function forOwner(error: string): ChannelErrorResponse {
    const text = error.replace(/\b(a|the) channel\b/gi, '$1 group');

    return { error: text };
}

async function readJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        return undefined;
    }
}

function readText(requestBody: unknown): string {
    if (typeof requestBody !== 'object' || requestBody === null || !('text' in requestBody)) {
        return '';
    }

    return typeof requestBody.text === 'string' ? requestBody.text.trim() : '';
}

async function botsById(bots: BotStore): Promise<Map<string, Bot>> {
    const list = await bots.list();
    const entries = list.map((bot): [string, Bot] => [bot.id, bot]);

    return new Map(entries);
}

function toMemberViews(channel: Channel, bots: Map<string, Bot>): ChannelMemberView[] {
    return channel.members.flatMap((member) => {
        const bot = bots.get(member.botId);

        if (bot === undefined) {
            return [];
        }

        return [{ botId: bot.id, name: bot.name, mascotColor: bot.mascotColor, mascotShape: bot.mascotShape, mascotEyes: bot.mascotEyes, isManager: member.isManager }];
    });
}

function toSummary(channel: Channel, bots: Map<string, Bot>): ChannelSummary {
    return { id: channel.id, name: channel.name, isIsolated: channel.isIsolated, members: toMemberViews(channel, bots) };
}

function toPostView(message: ChannelMessage): ChannelPostView {
    return {
        id: message.id,
        sequence: message.sequence,
        createdAt: message.createdAt,
        authorName: message.authorName,
        authorColor: message.authorColor,
        authorShape: message.authorShape,
        authorEyes: message.authorEyes,
        role: message.role,
        body: message.body,
    };
}

// The channel list and view. They sit behind the session check, like the other API routes.
function createChannelRoutes(options: ChannelRoutesOptions): Hono {
    const routes = new Hono();
    const rounds = options.rounds;
    const commandDeps: ChannelCommandDeps = {
        channels: options.channels,
        bots: options.bots,
        memberLeft: rounds === undefined ? undefined : (channelId, botId) => rounds.dropChannelMember(channelId, botId),
        channelDeleting: (channelId) => {
            rounds?.endChannelRounds(channelId);

            return Promise.resolve();
        },
    };

    routes.post('/api/channels', async (context) => {
        const rawSettings = await readJsonBody(context.req.raw);
        const settings = SETTINGS_SHAPE.safeParse(rawSettings);

        if (!settings.success) {
            return context.json(BAD_SETTINGS, 400);
        }

        const created = await createOwnerChannel(commandDeps, settings.data);

        if ('error' in created) {
            const refusal = forOwner(created.error);

            return context.json(refusal, 400);
        }

        const bots = await botsById(options.bots);
        const summary = toSummary(created.value, bots);

        return context.json(summary, 201);
    });

    routes.get('/api/channels', async (context) => {
        const channels = await options.channels.list();
        const bots = await botsById(options.bots);
        const summaries = channels.map(channel => toSummary(channel, bots));

        return context.json(summaries);
    });

    routes.get('/api/channels/:id', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        const bots = await botsById(options.bots);
        const messages = await options.channels.listRecentMessages(channel.id, RECENT_MESSAGE_LIMIT);
        const hasActiveRound = options.rounds?.hasActiveChannelRound(channel.id) ?? false;
        const detail: ChannelDetail = { ...toSummary(channel, bots), messages: messages.map(toPostView), hasActiveRound };

        return context.json(detail);
    });

    routes.get('/api/channels/:id/messages/:mid/file', async (context) => {
        const channelId = context.req.param('id');
        const postId = context.req.param('mid');
        const file = await options.rounds?.findChannelFile(channelId, postId);
        const response = file === undefined ? undefined : await respondWithStoredFile(context, file);

        return response ?? context.json(NO_CHANNEL_FILE, 404);
    });

    routes.put('/api/channels/:id', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        const rawSettings = await readJsonBody(context.req.raw);
        const settings = SETTINGS_SHAPE.safeParse(rawSettings);

        if (!settings.success) {
            return context.json(BAD_SETTINGS, 400);
        }

        const problem = await updateOwnerChannel(commandDeps, channel, settings.data);

        if (problem !== undefined) {
            const refusal = forOwner(problem);

            return context.json(refusal, 400);
        }

        const updated = await options.channels.getById(channelId);

        if (updated === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        const bots = await botsById(options.bots);
        const summary = toSummary(updated, bots);

        return context.json(summary);
    });

    routes.delete('/api/channels/:id', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        await deleteChannel(commandDeps, { channel: channel.name });

        return context.body(null, 204);
    });

    // The owner's post is stored in the channel only. The manager's turn that answers it comes with the hand-off dispatch.
    routes.post('/api/channels/:id/messages', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        const requestBody = await readJsonBody(context.req.raw);
        const text = readText(requestBody);

        if (text === '') {
            return context.json(EMPTY_TEXT, 400);
        }

        if (text.length > MAX_OWNER_POST_LENGTH) {
            return context.json(TOO_LONG, 400);
        }

        const saved = await options.channels.appendMessage(channelId, {
            authorBotId: undefined,
            authorName: OWNER_NAME,
            authorColor: OWNER_COLOR,
            authorShape: OWNER_SHAPE,
            authorEyes: OWNER_EYES,
            role: 'user',
            kind: 'text',
            body: { kind: 'text', text },
        });

        // The round runs in the background. The event stream tells the view each time the channel changes.
        options.rounds?.startChannelRound(channelId, text, saved.id)
            .catch((error: unknown) => {
                console.error('Starting a channel round failed', error);
            });

        const view = toPostView(saved);

        return context.json(view, 201);
    });

    // Stop ends the whole round of the channel: running replies stop and queued ones are dropped.
    routes.post('/api/channels/:id/stop', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        const stopped = (await options.rounds?.stopChannelRound(channelId)) ?? false;

        return context.json({ stopped });
    });

    return routes;
}

export { createChannelRoutes };
export type { ChannelRoutesOptions };
