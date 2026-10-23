import type { BotSummary } from '../shared/chatTypes.ts';

// The newest message sequence the owner has seen in each bot, by bot id.
type SeenSequences = Record<string, number>;

const STORAGE_KEY = 'cloudbot.seenSequences';

// The seen marks after this list of bots. The open bot counts as seen up to its newest message.
// A bot met for the first time counts as seen, so a new browser does not mark every chat. Returns the same object when nothing changed.
function updateSeen(seen: SeenSequences, bots: BotSummary[], openBotId: string | undefined): SeenSequences {
    const changedEntries = bots.flatMap((bot): [string, number][] => {
        const current = seen[bot.id];
        const isOpen = bot.id === openBotId;

        if (current === undefined || (isOpen && current < bot.lastMessageSequence)) {
            return [[bot.id, bot.lastMessageSequence]];
        }

        return [];
    });

    return changedEntries.length === 0 ? seen : { ...seen, ...Object.fromEntries(changedEntries) };
}

// The bots with hasUnread set for a message the owner has not seen in a chat that is not open.
function markUnread(bots: BotSummary[], seen: SeenSequences, openBotId: string | undefined): BotSummary[] {
    return bots.map((bot) => {
        const seenSequence = seen[bot.id] ?? bot.lastMessageSequence;
        const isUnread = bot.id !== openBotId && bot.lastMessageSequence > seenSequence;

        return isUnread === bot.hasUnread ? bot : { ...bot, hasUnread: isUnread };
    });
}

function loadSeen(): SeenSequences {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = stored === null ? {} : JSON.parse(stored);

        return typeof parsed === 'object' && parsed !== null ? parsed as SeenSequences : {};
    } catch {
        return {};
    }
}

function saveSeen(seen: SeenSequences): void {
    try {
        const seenText = JSON.stringify(seen);

        window.localStorage.setItem(STORAGE_KEY, seenText);
    } catch {
        // The marks work for this visit without storage.
    }
}

export { loadSeen, markUnread, saveSeen, updateSeen };
export type { SeenSequences };
