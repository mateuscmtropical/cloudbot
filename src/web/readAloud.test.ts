// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../shared/chatTypes.ts';
import { finishedReply, speakableText, splitForSpeech } from './readAloud.ts';

function textMessage(id: string, role: ChatMessage['role'], text: string): ChatMessage {
    return { id, role, botId: 'bot', sequence: 1, createdAt: 0, body: { kind: 'text', text } };
}

describe('speakableText', () => {
    it('drops the markdown marks and leaves code blocks out', () => {
        const text = speakableText('# Title\n\nSome **bold** word.\n\n```\nconst secret = 1;\n```\n\n- first\n- second');

        expect(text)
            .toContain('Some bold word.');
        expect(text)
            .toContain('Title');
        expect(text)
            .toContain('first');
        expect(text)
            .not.toContain('**');
        expect(text)
            .not.toContain('const secret');
    });
});

describe('splitForSpeech', () => {
    it('keeps every word, in order, in pieces under the limit', () => {
        const sentence = 'This is one sentence of a long reply. ';
        const longText = `${sentence.repeat(20)}${'word '.repeat(100)}`;
        const pieces = splitForSpeech(longText);
        const rejoined = pieces.join(' ')
            .replaceAll(/\s+/g, ' ');
        const lengths = pieces.map(piece => piece.length);

        expect(rejoined)
            .toBe(longText.trim());
        expect(Math.max(...lengths))
            .toBeLessThanOrEqual(200);
    });

    it('has nothing to read in an empty text', () => {
        expect(splitForSpeech('  \n '))
            .toEqual([]);
    });

    it('keeps a decimal number and a text without an end mark', () => {
        expect(splitForSpeech('It costs 2.5 reais'))
            .toEqual(['It costs 2.5 reais']);
    });
});

describe('finishedReply', () => {
    const reply = textMessage('reply', 'assistant', 'hello');
    const question = textMessage('question', 'user', 'hi');

    it('gives the newest reply once the turn has ended', () => {
        expect(finishedReply([question, reply], false))
            .toEqual({ id: 'reply', text: 'hello' });
    });

    it('waits during a turn and ignores a newest message from the person', () => {
        expect(finishedReply([question, reply], true))
            .toBeUndefined();
        expect(finishedReply([reply, question], false))
            .toBeUndefined();
    });
});
