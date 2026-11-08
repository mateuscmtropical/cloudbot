import type { BotSummary } from '../shared/chatTypes.ts';

// The newest message sequence the owner has seen in each chat, by chat id. A chat is a bot's own chat or one of its threads.
type SeenSequences = Record<string, number>;

const STORAGE_KEY = 'cloudbot.seenSequences';

// The own chat of a bot and its threads, with the newest message sequence of each.
function chatsOf(bot: BotSummary): { id: string; lastMessageSequence: number }[] {
    return [{ id: bot.id, lastMessageSequence: bot.lastMessageSequence }, ...(bot.threads ?? [])];
}

// The seen marks after this list of bots. The open chat counts as seen up to its newest message.
// A chat met for the first time counts as seen, so a new browser does not mark every chat. Returns the same object when nothing changed.
function updateSeen(seen: SeenSequences, bots: BotSummary[], openChatId: string | undefined): SeenSequences {
    const changedEntries = bots.flatMap(chatsOf)
        .flatMap((chat): [string, number][] => {
            const current = seen[chat.id];
            const isOpen = chat.id === openChatId;

            if (current === undefined || (isOpen && current < chat.lastMessageSequence)) {
                return [[chat.id, chat.lastMessageSequence]];
            }

            return [];
        });

    return changedEntries.length === 0 ? seen : { ...seen, ...Object.fromEntries(changedEntries) };
}

// The ids of the chats with a message the owner has not seen, apart from the open chat.
function unreadChatIds(bots: BotSummary[], seen: SeenSequences, openChatId: string | undefined): Set<string> {
    const unreadChats = bots.flatMap(chatsOf)
        .filter(chat => chat.id !== openChatId && chat.lastMessageSequence > (seen[chat.id] ?? chat.lastMessageSequence));

    const ids = unreadChats.map(chat => chat.id);

    return new Set(ids);
}

// The bots with hasUnread set when the bot or any of its threads has an unread chat. The open bot is never marked,
// since its chats show their own marks.
function markUnread(bots: BotSummary[], unreadIds: Set<string>, openBotId: string | undefined): BotSummary[] {
    return bots.map((bot) => {
        const hasUnreadChat = chatsOf(bot)
            .some(chat => unreadIds.has(chat.id));
        const isUnread = bot.id !== openBotId && hasUnreadChat;

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

export { loadSeen, markUnread, saveSeen, unreadChatIds, updateSeen };
export type { SeenSequences };
