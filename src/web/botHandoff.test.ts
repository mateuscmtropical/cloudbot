import { describe, expect, it } from 'vitest';

import type { BotSummary, ChatMessage } from '../shared/chatTypes.ts';
import { NOT_OWNER_LINE } from '../shared/botHandoffText.ts';
import { readHandoff } from './botHandoff.ts';

const NEWS = { id: 'news', name: 'News' } as BotSummary;
const CLOUD = { id: 'cloud', name: 'CloudBot' } as BotSummary;
const LONG_NAME = { id: 'long', name: 'News: daily (old)' } as BotSummary;
const BOTS = [CLOUD, NEWS, LONG_NAME];

function textMessage(role: 'user' | 'system' | 'assistant', text: string): ChatMessage {
    return { id: 'm', botId: 'cloud', role, sequence: 1, createdAt: 1, body: { kind: 'text', text } };
}

describe('readHandoff', () => {
    it('reads a received hand-off, and keeps its text when the bot is gone', () => {
        const fromNews = ['Message from bot News', NOT_OWNER_LINE, '', 'Hi'].join('\n');
        const fromGone = ['Message from bot Gone', NOT_OWNER_LINE, '', 'Hi'].join('\n');

        expect(readHandoff(BOTS, textMessage('user', fromNews)))
            .toEqual({ label: 'News', text: 'Hi', bot: NEWS });
        expect(readHandoff(BOTS, textMessage('user', fromGone)))
            .toEqual({ label: 'Gone', text: 'Hi', bot: undefined });
    });

    it('shows a sent note as this bot, addressed to the other', () => {
        expect(readHandoff(BOTS, textMessage('system', 'Sent to News: Find the: top video.')))
            .toEqual({ label: 'To News', text: 'Find the: top video.', bot: CLOUD });
    });

    it('shows a reply as the bot that replied, with the outcome when it did not finish', () => {
        expect(readHandoff(BOTS, textMessage('system', 'Reply from News:\n\nDone.')))
            .toEqual({ label: 'News', text: 'Done.', bot: NEWS });
        expect(readHandoff(BOTS, textMessage('system', 'Reply from News (stopped):\n\nPartly.')))
            .toEqual({ label: 'News (stopped)', text: 'Partly.', bot: NEWS });
    });

    it('matches the longest name when one name starts with another', () => {
        expect(readHandoff(BOTS, textMessage('system', 'Sent to News: daily (old): Hi')))
            .toEqual({ label: 'To News: daily (old)', text: 'Hi', bot: CLOUD });
        expect(readHandoff(BOTS, textMessage('system', 'Reply from News: daily (old):\n\nDone.')))
            .toEqual({ label: 'News: daily (old)', text: 'Done.', bot: LONG_NAME });
    });

    it('leaves everything else as it was', () => {
        const others = [
            textMessage('user', 'Hi'),
            textMessage('assistant', 'Sent to News: Hi'),
            textMessage('system', 'Reply from News: no text reply.'),
            textMessage('system', 'Reply from News: no reply, the turn failed.'),
            textMessage('system', 'The hand-off to News was not sent: too many.'),
            textMessage('system', 'Sent to Gone: Hi'),
        ];
        const views = others.map(message => readHandoff(BOTS, message));

        expect(views)
            .toEqual(others.map(() => undefined));
    });
});
