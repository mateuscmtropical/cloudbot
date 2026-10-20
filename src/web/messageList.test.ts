import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../shared/chatTypes.ts';
import { upsertMessage } from './messageList.ts';

function createMessage(id: string, text: string): ChatMessage {
    return {
        id,
        botId: 'bot-1',
        role: 'assistant',
        createdAt: 1,
        body: { kind: 'text', text },
    };
}

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
