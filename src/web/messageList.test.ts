import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../shared/chatTypes.ts';
import { mergeMessages, upsertMessage } from './messageList.ts';

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
