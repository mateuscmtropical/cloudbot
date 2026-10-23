import { describe, expect, it } from 'vitest';

import { BOT_HANDOFF_PREFIX, NOT_OWNER_LINE, parseBotHandoffText } from './botHandoffText.ts';

describe('parseBotHandoffText', () => {
    it('reads the sender and the text of a hand-off', () => {
        const text = [`${BOT_HANDOFF_PREFIX}News`, NOT_OWNER_LINE, '', 'Find the top video.', 'Be quick.'].join('\n');

        expect(parseBotHandoffText(text))
            .toEqual({ senderName: 'News', text: 'Find the top video.\nBe quick.' });
    });

    it('leaves an owner message that only starts like a hand-off', () => {
        expect(parseBotHandoffText(`${BOT_HANDOFF_PREFIX}News\nhello`))
            .toBeUndefined();
        expect(parseBotHandoffText('Hello'))
            .toBeUndefined();
    });

    it('needs the blank line before the text', () => {
        expect(parseBotHandoffText(`${BOT_HANDOFF_PREFIX}News\n${NOT_OWNER_LINE}\ntext`))
            .toBeUndefined();
    });
});
