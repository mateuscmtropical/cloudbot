import type { RuleStore } from '../store/RuleStore.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { ChannelMessage, ChannelStore } from '../store/ChannelStore.ts';
import type { ReviewContext } from './createToolCallReviewer.ts';
import { isWebhookMessage } from '../webhooks/webhookMessage.ts';
import { isWatchMessage } from '../watches/watchMessage.ts';
import { HANDOFF_REPLY_PREFIX, HANDOFF_SENT_PREFIX, isBotHandoffMessage } from '../bots/botHandoff.ts';
import { CHANNEL_TRANSCRIPT_LIMIT, transcriptLine } from '../channels/channelRound.ts';
import { TASK_BLOCKED_NOTICE_PREFIX } from '../../shared/taskTypes.ts';

interface ReviewContextSources {
    ruleStore: Pick<RuleStore, 'list'>;
    messageStore: Pick<MessageStore, 'listByBot'>;
    modelStore: Pick<ModelStore, 'get' | 'getEfforts'>;
    // The posts a channel turn is reviewed against. Without it a channel review gets no chat lines, never the bot's own chat.
    channelStore?: Pick<ChannelStore, 'listRecentMessages'>;
    messageCount?: number;
}

const DEFAULT_MESSAGE_COUNT = 6;
const ROLE_LABELS = { user: 'Owner', assistant: 'Bot', system: 'System' };
const WEBHOOK_LABEL = 'Webhook (outside data)';
const WATCH_LABEL = 'Page watch (outside data)';
const HANDOFF_LABEL = 'Message from another bot (not the owner)';
const HANDOFF_REPLY_LABEL = 'Reply from another bot (outside data)';
const HANDOFF_SENT_LABEL = 'Hand-off sent by this bot';
const BOT_NOTE_LABEL = 'Note written by this bot (not the owner)';

interface StoredMessage {
    role: keyof typeof ROLE_LABELS;
    content: unknown;
}

// Only plain text counts. Cards, files and tool activity say little about what the owner wants.
// A webhook message is saved as a user message, so it gets its own label. It is outside data, not the owner.
function toChatLine(message: StoredMessage): string[] {
    const content = message.content as { kind?: unknown; text?: unknown } | null;

    if (content?.kind !== 'text' || typeof content.text !== 'string') {
        return [];
    }

    // One line per message, so a message cannot start a line that looks like another entry.
    const oneLineText = content.text.replace(/\s+/g, ' ');

    if (message.role === 'user' && isWebhookMessage(content.text)) {
        return [`${WEBHOOK_LABEL}: ${oneLineText}`];
    }

    // A page watch message carries page text from outside, so it is labeled the same way.
    if (message.role === 'user' && isWatchMessage(content.text)) {
        return [`${WATCH_LABEL}: ${oneLineText}`];
    }

    // A message from another bot is not the owner either.
    if (message.role === 'user' && isBotHandoffMessage(content.text)) {
        return [`${HANDOFF_LABEL}: ${oneLineText}`];
    }

    // The hand-off notes are written by the server into the sender's chat, so they are labeled by their fixed starts.
    if (message.role === 'system' && content.text.startsWith(HANDOFF_REPLY_PREFIX)) {
        return [`${HANDOFF_REPLY_LABEL}: ${oneLineText}`];
    }

    if (message.role === 'system' && content.text.startsWith(HANDOFF_SENT_PREFIX)) {
        return [`${HANDOFF_SENT_LABEL}: ${oneLineText}`];
    }

    // A task notice is written by the bot from its own tool call, so it is not a message from the app.
    if (message.role === 'system' && content.text.startsWith(TASK_BLOCKED_NOTICE_PREFIX)) {
        return [`${BOT_NOTE_LABEL}: ${oneLineText}`];
    }

    return [`${ROLE_LABELS[message.role]}: ${oneLineText}`];
}

// A channel post gets the same labels as the channel turn's transcript, so the review reads it the way the bot did.
function toChannelLine(post: ChannelMessage): string[] {
    if (post.body.kind !== 'text' || (post.role !== 'user' && post.role !== 'assistant')) {
        return [];
    }

    const oneLineText = post.body.text.replace(/\s+/g, ' ');

    return [transcriptLine({ isOwner: post.role === 'user', authorName: post.authorName, text: oneLineText })];
}

function createReviewContextReader(sources: ReviewContextSources): (botId: string, channelId?: string) => Promise<ReviewContext> {
    const messageCount = sources.messageCount ?? DEFAULT_MESSAGE_COUNT;

    const readChatLines = async (botId: string): Promise<string[]> => {
        const messages = await sources.messageStore.listByBot(botId, { limit: messageCount });

        return messages.flatMap(toChatLine);
    };

    const readChannelLines = async (channelId: string): Promise<string[]> => {
        if (sources.channelStore === undefined) {
            return [];
        }

        const posts = await sources.channelStore.listRecentMessages(channelId, CHANNEL_TRANSCRIPT_LIMIT);

        return posts.flatMap(toChannelLine);
    };

    return async (botId, channelId) => {
        const [rules, recentMessages, modelChoices, efforts] = await Promise.all([
            sources.ruleStore.list(botId),
            channelId === undefined ? readChatLines(botId) : readChannelLines(channelId),
            sources.modelStore.get(botId),
            sources.modelStore.getEfforts(botId),
        ]);
        const reviewModelOption = modelChoices.review === null ? {} : { reviewModel: modelChoices.review };
        const reviewEffortOption = efforts.review === null ? {} : { reviewEffort: efforts.review };

        return {
            ownerRules: rules.map(rule => `${rule.kind === 'block' ? 'Block' : 'Allow'}: ${rule.text}`),
            recentMessages,
            ...reviewModelOption,
            ...reviewEffortOption,
        };
    };
}

export { createReviewContextReader };
export type { ReviewContextSources };
