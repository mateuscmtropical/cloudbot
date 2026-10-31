import { Hono } from 'hono';

import type { ChannelDetail, ChannelMemberView, ChannelPostView, ChannelSummary } from '../../shared/channelTypes.ts';
import type { ChatService } from '../chat/ChatService.ts';
import type { BotStore } from '../store/BotStore.ts';
import type { Channel, ChannelMessage, ChannelStore } from '../store/ChannelStore.ts';
import type { Bot } from '../store/types.ts';

interface ChannelRoutesOptions {
    channels: ChannelStore;
    bots: BotStore;
    // Starts the bot turns of a channel round, and stops them. Without it posts are stored but nothing answers.
    rounds?: Pick<ChatService, 'startChannelRound' | 'stopChannelRound' | 'hasActiveChannelRound'> | undefined;
}

interface ChannelErrorResponse {
    error: string;
}

const CHANNEL_NOT_FOUND: ChannelErrorResponse = { error: 'No channel has this id.' };
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
    return { id: channel.id, name: channel.name, members: toMemberViews(channel, bots) };
}

function toPostView(message: ChannelMessage): ChannelPostView {
    return {
        id: message.id,
        sequence: message.sequence,
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

    // The owner's post is stored in the channel only. The manager's turn that answers it comes with the hand-off dispatch.
    routes.post('/api/channels/:id/messages', async (context) => {
        const channelId = context.req.param('id');
        const channel = await options.channels.getById(channelId);

        if (channel === undefined) {
            return context.json(CHANNEL_NOT_FOUND, 404);
        }

        let requestBody: unknown;

        try {
            requestBody = await context.req.json();
        } catch {
            requestBody = undefined;
        }

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

        // The round runs in the background. The view polls the channel until its bots finish.
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
