import type { RuleStore } from '../store/RuleStore.ts';
import type { MessageStore } from '../store/MessageStore.ts';
import type { ReviewContext } from './createToolCallReviewer.ts';

interface ReviewContextSources {
    ruleStore: Pick<RuleStore, 'list'>;
    messageStore: Pick<MessageStore, 'listByBot'>;
    messageCount?: number;
}

const DEFAULT_MESSAGE_COUNT = 6;
const ROLE_LABELS = { user: 'Owner', assistant: 'Bot', system: 'System' };

interface StoredMessage {
    role: keyof typeof ROLE_LABELS;
    content: unknown;
}

// Only plain text counts. Cards, files and tool activity say little about what the owner wants.
function toChatLine(message: StoredMessage): string[] {
    const content = message.content as { kind?: unknown; text?: unknown } | null;

    if (content?.kind !== 'text' || typeof content.text !== 'string') {
        return [];
    }

    return [`${ROLE_LABELS[message.role]}: ${content.text}`];
}

function createReviewContextReader(sources: ReviewContextSources): (botId: string) => Promise<ReviewContext> {
    const messageCount = sources.messageCount ?? DEFAULT_MESSAGE_COUNT;

    return async (botId) => {
        const [rules, messages] = await Promise.all([
            sources.ruleStore.list(botId),
            sources.messageStore.listByBot(botId, { limit: messageCount }),
        ]);

        return {
            ownerRules: rules.map(rule => `${rule.kind === 'block' ? 'Block' : 'Allow'}: ${rule.text}`),
            recentMessages: messages.flatMap(toChatLine),
        };
    };
}

export { createReviewContextReader };
export type { ReviewContextSources };
