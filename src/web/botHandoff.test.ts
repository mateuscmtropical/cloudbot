import { describe, expect, it } from 'vitest';

import type { BotSummary, ChatMessage } from '../shared/chatTypes.ts';
import { NOT_OWNER_LINE } from '../shared/botHandoffText.ts';
import { findHandoffSender } from './botHandoff.ts';

const NEWS = { id: 'news', name: 'News' } as BotSummary;
const CLOUD = { id: 'cloud', name: 'CloudBot' } as BotSummary;

function userMessage(text: string): ChatMessage {
    return { id: 'm', botId: 'cloud', role: 'user', sequence: 1, createdAt: 1, body: { kind: 'text', text } };
}

describe('findHandoffSender', () => {
    it('finds the bot named in a hand-off', () => {
        const text = ['Message from bot News', NOT_OWNER_LINE, '', 'Hi'].join('\n');

        expect(findHandoffSender([CLOUD, NEWS], userMessage(text)))
            .toBe(NEWS);
    });

    it('finds nothing for an owner message or a bot that is gone', () => {
        const text = ['Message from bot Gone', NOT_OWNER_LINE, '', 'Hi'].join('\n');

        expect(findHandoffSender([CLOUD, NEWS], userMessage('Hi')))
            .toBeUndefined();
        expect(findHandoffSender([CLOUD, NEWS], userMessage(text)))
            .toBeUndefined();
    });
});
