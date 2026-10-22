import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../shared/chatTypes.ts';
import { mergeMessages, removeMessages, upsertLiveMessage, upsertMessage } from './messageList.ts';

function createMessage(id: string, text: string, sequence = 1): ChatMessage {
    return {
        id,
        botId: 'bot-1',
        role: 'assistant',
        createdAt: 1,
        sequence,
        body: { kind: 'text', text },
    };
}

describe('removeMessages', () => {
    it('drops the listed messages and ignores ids it does not hold', () => {
        const held = [createMessage('m1', 'one', 1), createMessage('m2', 'two', 2), createMessage('m3', 'three', 3)];

        expect(removeMessages(held, ['m1', 'm3', 'missing']))
            .toEqual([held[1]]);
    });
});

describe('upsertLiveMessage', () => {
    it('leaves out an unheld message older than the oldest held one, so paging skips nothing', () => {
        const held = [createMessage('m60', 'held', 60), createMessage('m61', 'held', 61)];
        const oldUpdate = createMessage('m10', 'updated setup question', 10);

        expect(upsertLiveMessage(held, oldUpdate))
            .toBe(held);
    });

    it('updates a held message in place and keeps store order for a new one', () => {
        const held = [createMessage('m1', 'first', 1), createMessage('m3', 'third', 3)];
        const updated = upsertLiveMessage(held, createMessage('m1', 'first updated', 1));
        const inserted = upsertLiveMessage(updated, createMessage('m2', 'second', 2));

        expect(inserted.map(message => message.id))
            .toEqual(['m1', 'm2', 'm3']);
        expect(inserted[0]?.body)
            .toEqual({ kind: 'text', text: 'first updated' });
    });
});

describe('mergeMessages', () => {
    it('keeps a message that arrived by the event stream when the loaded list lacks it', () => {
        const streamed = createMessage('m2', 'streamed', 2);
        const loaded = [createMessage('m1', 'loaded', 1)];

        const messages = mergeMessages([streamed], loaded);

        expect(messages.map(message => message.id))
            .toEqual(['m1', 'm2']);
    });

    it('keeps creation order and does not duplicate a message present in both lists', () => {
        const older = createMessage('m1', 'older', 1);
        const newer = createMessage('m2', 'newer', 2);

        const messages = mergeMessages([newer], [older, newer]);

        expect(messages)
            .toEqual([older, newer]);
    });

    it('orders messages created in the same millisecond by store sequence', () => {
        const first = createMessage('m1', 'first', 1);
        const second = createMessage('m2', 'second', 2);

        const messages = mergeMessages([second], [first]);

        expect(messages.map(message => message.id))
            .toEqual(['m1', 'm2']);
    });
});

describe('upsertMessage', () => {
    it('appends a message that is not in the list yet', () => {
        const first = createMessage('m1', 'hello');
        const second = createMessage('m2', 'world');

        const messages = upsertMessage([first], second);

        expect(messages.map(message => message.id))
            .toEqual(['m1', 'm2']);
    });

    it('replaces a message with the same id in place', () => {
        const first = createMessage('m1', 'partial');
        const second = createMessage('m2', 'other');
        const updated = createMessage('m1', 'complete');

        const messages = upsertMessage([first, second], updated);

        expect(messages)
            .toEqual([updated, second]);
    });
});
