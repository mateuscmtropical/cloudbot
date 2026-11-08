import { describe, expect, it } from 'vitest';

import type { BotSummary } from '../shared/chatTypes.ts';
import { markUnread, unreadChatIds, updateSeen } from './unreadMarks.ts';

function createBot(id: string, lastMessageSequence: number, threads?: BotSummary['threads']): BotSummary {
    return { id, name: id, title: '', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', mascotWeather: 'auto', mascotBolt: 'down', lastMessagePreview: '', hasUnread: false, lastMessageSequence, ...(threads === undefined ? {} : { threads }) };
}

describe('updateSeen', () => {
    it('counts a bot met for the first time as seen', () => {
        expect(updateSeen({}, [createBot('a', 7)], undefined))
            .toEqual({ a: 7 });
    });

    it('moves the open bot up to its newest message and leaves the others', () => {
        const seen = { a: 3, b: 3 };

        expect(updateSeen(seen, [createBot('a', 9), createBot('b', 9)], 'a'))
            .toEqual({ a: 9, b: 3 });
    });

    it('returns the same object when nothing changed', () => {
        const seen = { a: 9 };

        expect(updateSeen(seen, [createBot('a', 9)], 'a'))
            .toBe(seen);
    });

    it('moves only the open thread up, not its bot or its sibling threads', () => {
        const seen = { a: 3, t1: 3, t2: 3 };
        const bot = createBot('a', 9, [{ id: 't1', lastMessageSequence: 9 }, { id: 't2', lastMessageSequence: 9 }]);

        expect(updateSeen(seen, [bot], 't1'))
            .toEqual({ a: 3, t1: 9, t2: 3 });
    });

    it('counts a thread met for the first time as seen', () => {
        const bot = createBot('a', 4, [{ id: 't1', lastMessageSequence: 6 }]);

        expect(updateSeen({ a: 4 }, [bot], 'a'))
            .toEqual({ a: 4, t1: 6 });
    });
});

describe('markUnread', () => {
    it('marks a closed chat with a newer message and clears the open one', () => {
        const bots = [createBot('a', 9), createBot('b', 9)];
        const seen = { a: 3, b: 3 };
        const marked = markUnread(bots, unreadChatIds(bots, seen, 'a'), 'a');

        expect(marked.map(bot => bot.hasUnread))
            .toEqual([false, true]);
    });

    it('does not mark a chat that has nothing new', () => {
        const bots = [createBot('a', 4)];
        const marked = markUnread(bots, unreadChatIds(bots, { a: 4 }, undefined), undefined);

        expect(marked[0]?.hasUnread)
            .toBe(false);
    });

    it('marks the bot when only one of its threads has a newer message', () => {
        const bots = [createBot('a', 4, [{ id: 't1', lastMessageSequence: 8 }]), createBot('b', 4)];
        const marked = markUnread(bots, unreadChatIds(bots, { a: 4, t1: 5, b: 4 }, 'b'), 'b');

        expect(marked.map(bot => bot.hasUnread))
            .toEqual([true, false]);
    });

    it('does not mark the open bot for another thread, but lists that thread as unread', () => {
        const bots = [createBot('a', 4, [{ id: 't1', lastMessageSequence: 8 }])];
        const unreadIds = unreadChatIds(bots, { a: 4, t1: 5 }, 'a');

        expect(markUnread(bots, unreadIds, 'a')[0]?.hasUnread)
            .toBe(false);
        expect([...unreadIds])
            .toEqual(['t1']);
    });

    it('clears the mark once the thread is open', () => {
        const bots = [createBot('a', 4, [{ id: 't1', lastMessageSequence: 8 }])];

        expect([...unreadChatIds(bots, { a: 4, t1: 5 }, 't1')])
            .toEqual([]);
    });
});
