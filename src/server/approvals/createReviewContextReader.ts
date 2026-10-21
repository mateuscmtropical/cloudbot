import type { RuleStore } from '../store/RuleStore.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { ModelStore } from '../store/ModelStore.ts';
import type { ReviewContext } from './createToolCallReviewer.ts';
import { isWebhookMessage } from '../webhooks/webhookMessage.ts';

interface ReviewContextSources {
    ruleStore: Pick<RuleStore, 'list'>;
    messageStore: Pick<MessageStore, 'listByBot'>;
    modelStore: Pick<ModelStore, 'get'>;
    messageCount?: number;
}

const DEFAULT_MESSAGE_COUNT = 6;
const ROLE_LABELS = { user: 'Owner', assistant: 'Bot', system: 'System' };
const WEBHOOK_LABEL = 'Webhook (outside data)';

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

    return [`${ROLE_LABELS[message.role]}: ${oneLineText}`];
}

function createReviewContextReader(sources: ReviewContextSources): (botId: string) => Promise<ReviewContext> {
    const messageCount = sources.messageCount ?? DEFAULT_MESSAGE_COUNT;

    return async (botId) => {
        const [rules, messages, modelChoices] = await Promise.all([
            sources.ruleStore.list(botId),
            sources.messageStore.listByBot(botId, { limit: messageCount }),
            sources.modelStore.get(botId),
        ]);
        const reviewModelOption = modelChoices.review === null ? {} : { reviewModel: modelChoices.review };

        return {
            ownerRules: rules.map(rule => `${rule.kind === 'block' ? 'Block' : 'Allow'}: ${rule.text}`),
            recentMessages: messages.flatMap(toChatLine),
            ...reviewModelOption,
        };
    };
}

export { createReviewContextReader };
export type { ReviewContextSources };
