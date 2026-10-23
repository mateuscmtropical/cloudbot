import { describe, expect, it } from 'vitest';

import type { BotSummary } from '../shared/chatTypes.ts';
import { markUnread, updateSeen } from './unreadMarks.ts';

function createBot(id: string, lastMessageSequence: number): BotSummary {
    return { id, name: id, title: '', mascotColor: 'blue', mascotShape: 'puff', lastMessagePreview: '', hasUnread: false, lastMessageSequence };
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
});

describe('markUnread', () => {
    it('marks a closed chat with a newer message and clears the open one', () => {
        const bots = [createBot('a', 9), createBot('b', 9)];
        const marked = markUnread(bots, { a: 3, b: 3 }, 'a');

        expect(marked.map(bot => bot.hasUnread))
            .toEqual([false, true]);
    });

    it('does not mark a chat that has nothing new', () => {
        const marked = markUnread([createBot('a', 4)], { a: 4 }, undefined);

        expect(marked[0]?.hasUnread)
            .toBe(false);
    });
});
