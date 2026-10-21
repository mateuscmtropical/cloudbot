import { describe, expect, it } from 'vitest';

import type { ChatMessage, ChatRole } from '../shared/chatTypes.ts';
import { isLastOfBotRun, showsMessageMascot } from './messageMascot.ts';

function makeMessage(id: string, role: ChatRole, botId = 'bot-a'): ChatMessage {
    return { id, botId, role, sequence: 1, createdAt: 1, body: { kind: 'text', text: id } };
}

describe('isLastOfBotRun', () => {
    it('shows the mascot on a single bot message', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('a1', 'assistant')];

        expect(isLastOfBotRun(messages, 1))
            .toBe(true);
    });

    it('shows the mascot only on the last of consecutive bot messages', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('a1', 'assistant'), makeMessage('a2', 'assistant'), makeMessage('a3', 'assistant')];

        expect(isLastOfBotRun(messages, 1))
            .toBe(false);
        expect(isLastOfBotRun(messages, 2))
            .toBe(false);
        expect(isLastOfBotRun(messages, 3))
            .toBe(true);
    });

    it('starts a new run after a user message, so each run shows its last message', () => {
        const messages = [
            makeMessage('a1', 'assistant'),
            makeMessage('u1', 'user'),
            makeMessage('a2', 'assistant'),
        ];

        expect(isLastOfBotRun(messages, 0))
            .toBe(true);
        expect(isLastOfBotRun(messages, 2))
            .toBe(true);
    });

    it('ends a run at a system note', () => {
        const messages = [makeMessage('a1', 'assistant'), makeMessage('s1', 'system'), makeMessage('a2', 'assistant')];

        expect(isLastOfBotRun(messages, 0))
            .toBe(true);
    });

    it('never shows the mascot on a user or system message', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('s1', 'system')];

        expect(isLastOfBotRun(messages, 0))
            .toBe(false);
        expect(isLastOfBotRun(messages, 1))
            .toBe(false);
    });

    it('ends a run when the next message comes from another bot', () => {
        const messages = [makeMessage('a1', 'assistant', 'bot-a'), makeMessage('a2', 'assistant', 'bot-b')];

        expect(isLastOfBotRun(messages, 0))
            .toBe(true);
    });

    it('returns false for an index past the end of the list', () => {
        expect(isLastOfBotRun([], 0))
            .toBe(false);
    });
});

describe('showsMessageMascot', () => {
    const noDraft = { isShown: false, botId: undefined };

    it('keeps the mascot of an earlier run when a streamed reply is on screen', () => {
        const messages = [makeMessage('a1', 'assistant'), makeMessage('u1', 'user')];

        expect(showsMessageMascot(messages, 0, { isShown: true, botId: 'bot-a' }))
            .toBe(true);
    });

    it('moves the mascot from the last message to a streamed reply of the same bot', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('a1', 'assistant')];

        expect(showsMessageMascot(messages, 1, { isShown: true, botId: 'bot-a' }))
            .toBe(false);
    });

    it('keeps the mascot of the last message when the streamed reply belongs to another bot', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('a1', 'assistant', 'bot-a')];

        expect(showsMessageMascot(messages, 1, { isShown: true, botId: 'bot-b' }))
            .toBe(true);
    });

    it('keeps the mascot of the last message when no streamed reply is on screen', () => {
        const messages = [makeMessage('u1', 'user'), makeMessage('a1', 'assistant')];

        expect(showsMessageMascot(messages, 1, noDraft))
            .toBe(true);
    });

    it('does not show a mascot on a message in the middle of a run', () => {
        const messages = [makeMessage('a1', 'assistant'), makeMessage('a2', 'assistant')];

        expect(showsMessageMascot(messages, 0, { isShown: true, botId: 'bot-a' }))
            .toBe(false);
    });
});
