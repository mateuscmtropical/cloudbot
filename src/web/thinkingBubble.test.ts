import { describe, expect, it } from 'vitest';

import type { ChatMessage, ToolStatus } from '../shared/chatTypes.ts';
import { FALLBACK_TOOL_PHRASE, THINKING_LINES, isThinkingBubbleShown, thinkingLineAt, toolPhrase, withoutToolRows } from './thinkingBubble.ts';

function makeMessage(id: string, body: ChatMessage['body'], role: ChatMessage['role'] = 'assistant'): ChatMessage {
    return { id, botId: 'bot-a', role, sequence: 1, createdAt: 1, body };
}

function makeTextMessage(id: string): ChatMessage {
    return makeMessage(id, { kind: 'text', text: id });
}

function makeUserMessage(id: string): ChatMessage {
    return makeMessage(id, { kind: 'text', text: id }, 'user');
}

function makeToolMessage(id: string, status: ToolStatus = 'done'): ChatMessage {
    return makeMessage(id, { kind: 'toolActivity', toolName: 'Bash', status, summary: 'ls' });
}

function makeApprovalMessage(id: string, chosenId?: string): ChatMessage {
    const choice = { kind: 'choice' as const, prompt: 'Allow?', options: [{ id: 'yes', label: 'Yes' }], isApproval: true };

    return makeMessage(id, chosenId === undefined ? choice : { ...choice, chosenId });
}

function makeFormMessage(id: string, submitted: boolean): ChatMessage {
    return makeMessage(id, { kind: 'secureForm', prompt: 'Add your key', secretName: 'API_KEY', submitted });
}

function makeSystemMessage(id: string, text: string): ChatMessage {
    return makeMessage(id, { kind: 'text', text }, 'system');
}

describe('thinkingLineAt', () => {
    it('cycles through the thinking lines', () => {
        expect(thinkingLineAt(0))
            .toBe(THINKING_LINES[0]);
        expect(thinkingLineAt(1))
            .toBe(THINKING_LINES[1]);
        expect(thinkingLineAt(THINKING_LINES.length))
            .toBe(THINKING_LINES[0]);
    });

    it('changes the line on each step', () => {
        expect(thinkingLineAt(0))
            .not.toBe(thinkingLineAt(1));
    });
});

describe('toolPhrase', () => {
    it('names a known built-in tool in plain words', () => {
        expect(toolPhrase('WebFetch'))
            .toBe('Reading a web page');
    });

    it('names a known bot tool in plain words', () => {
        expect(toolPhrase('mcp__cloudbot__browser_screenshot'))
            .toBe('Taking a screenshot');
    });

    it('falls back for a tool it does not know', () => {
        expect(toolPhrase('mcp__cloudbot__future_tool'))
            .toBe(FALLBACK_TOOL_PHRASE);
        expect(FALLBACK_TOOL_PHRASE)
            .toBe('Working on it');
    });
});

describe('isThinkingBubbleShown', () => {
    it('shows while a turn runs and no reply is streaming', () => {
        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages: [makeTextMessage('u1')] }))
            .toBe(true);
    });

    it('hides when no turn runs', () => {
        expect(isThinkingBubbleShown({ isRunning: false, draftText: '', messages: [] }))
            .toBe(false);
    });

    it('hides once the reply starts streaming', () => {
        expect(isThinkingBubbleShown({ isRunning: true, draftText: 'Hi', messages: [] }))
            .toBe(false);
    });

    it('hides while an approval question waits for the owner', () => {
        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages: [makeApprovalMessage('c1')] }))
            .toBe(false);
    });

    it('shows again after the owner answers an approval question', () => {
        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages: [makeApprovalMessage('c1', 'yes')] }))
            .toBe(true);
    });

    it('hides while a field the owner has not sent is open after the last message', () => {
        const messages = [makeUserMessage('u1'), makeFormMessage('f1', false)];

        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages }))
            .toBe(false);
    });

    it('ignores a field from before the owner last wrote, such as one left by a restart', () => {
        const messages = [makeFormMessage('f1', false), makeUserMessage('u1')];

        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages }))
            .toBe(true);
    });

    it('hides during a usage limit wait after the last message', () => {
        const messages = [makeUserMessage('u1'), makeSystemMessage('s1', 'The usage limit was reached. CloudBot continues at 10:00.')];

        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages }))
            .toBe(false);
    });

    it('shows for a note that is not a usage limit wait', () => {
        const messages = [makeUserMessage('u1'), makeSystemMessage('s1', 'Something else happened.')];

        expect(isThinkingBubbleShown({ isRunning: true, draftText: '', messages }))
            .toBe(true);
    });
});

describe('withoutToolRows', () => {
    it('drops tool rows and keeps every other message in order', () => {
        const messages = [makeTextMessage('u1'), makeToolMessage('t1'), makeTextMessage('a1'), makeApprovalMessage('c1')];

        const remaining = withoutToolRows(messages);

        expect(remaining.map(message => message.id))
            .toEqual(['u1', 'a1', 'c1']);
    });

    it('keeps a tool row that ended in an error', () => {
        const messages = [makeToolMessage('t1', 'error'), makeToolMessage('t2', 'done')];

        const remaining = withoutToolRows(messages);

        expect(remaining.map(message => message.id))
            .toEqual(['t1']);
    });
});
