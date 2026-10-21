import { describe, expect, it } from 'vitest';

import type { ChatMessage, MessageBody } from '../shared/chatTypes.ts';
import { deriveMascotState } from './mascotState.ts';

const BOT_ID = 'bot-1';

function message(role: ChatMessage['role'], body: MessageBody, sequence: number): ChatMessage {
    return { id: `m-${String(sequence)}`, botId: BOT_ID, role, createdAt: sequence, sequence, body };
}

function userText(sequence: number): ChatMessage {
    return message('user', { kind: 'text', text: 'Hi' }, sequence);
}

function assistantText(sequence: number): ChatMessage {
    return message('assistant', { kind: 'text', text: 'Hello' }, sequence);
}

function systemText(text: string, sequence: number): ChatMessage {
    return message('system', { kind: 'text', text }, sequence);
}

function pendingApproval(sequence: number): ChatMessage {
    return message('assistant', { kind: 'choice', prompt: 'Allow it?', options: [{ id: 'yes', label: 'Yes' }], isApproval: true }, sequence);
}

const IDLE_INPUT = { isRunning: false, isOwnerTyping: false, isJustFinished: false, messages: [] };

describe('deriveMascotState', () => {
    it('is idle with nothing going on', () => {
        expect(deriveMascotState(IDLE_INPUT))
            .toBe('idle');
    });

    it('is typing while the owner has text in the composer', () => {
        expect(deriveMascotState({ ...IDLE_INPUT, isOwnerTyping: true }))
            .toBe('typing');
    });

    it('is thinking while a turn runs', () => {
        expect(deriveMascotState({ ...IDLE_INPUT, isRunning: true }))
            .toBe('thinking');
    });

    it('is done for a turn that just ended without a failure', () => {
        expect(deriveMascotState({ ...IDLE_INPUT, isJustFinished: true, messages: [userText(1), assistantText(2)] }))
            .toBe('done');
    });

    it('is waiting while an approval card has no answer', () => {
        expect(deriveMascotState({ ...IDLE_INPUT, messages: [userText(1), pendingApproval(2)] }))
            .toBe('waiting');
    });

    it('is not waiting once the approval card was answered', () => {
        const answered = message('assistant', { kind: 'choice', prompt: 'Allow it?', options: [{ id: 'yes', label: 'Yes' }], isApproval: true, chosenId: 'yes' }, 2);

        expect(deriveMascotState({ ...IDLE_INPUT, messages: [userText(1), answered] }))
            .toBe('idle');
    });

    it('is waiting over typing and over a running turn', () => {
        const messages = [userText(1), pendingApproval(2)];

        expect(deriveMascotState({ isRunning: true, isOwnerTyping: true, isJustFinished: false, messages }))
            .toBe('waiting');
    });

    it('is thinking over typing, so a running turn stays visible while the owner types', () => {
        expect(deriveMascotState({ ...IDLE_INPUT, isRunning: true, isOwnerTyping: true }))
            .toBe('thinking');
    });

    it('is sleepy after a usage limit note, with no answer after it', () => {
        const messages = [userText(1), systemText('The usage limit was reached. CloudBot continues at 10:00.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('sleepy');
    });

    it('is error after the stall note, with no answer after it', () => {
        const messages = [userText(1), systemText('The turn stopped because it sent nothing for 10 minutes.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('error');
    });

    it('is error after a limit stop note', () => {
        const messages = [userText(1), systemText('The turn stopped at the time limit of 5 minutes. Raise it in the Limits section of the Models panel, or ask me to change it.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('error');
    });

    it('is error after a fixed turn error note', () => {
        const messages = [userText(1), systemText('The turn ended with an error.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('error');
    });

    it('is error after the workspace error note', () => {
        const messages = [userText(1), systemText('Could not prepare the agent workspace. Please try again.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('error');
    });

    it('stays idle after a system note that is not a known failure', () => {
        const messages = [userText(1), systemText('Something else happened.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('idle');
    });

    it('is error over done when the turn that just ended failed', () => {
        const messages = [userText(1), systemText('The turn stopped because it sent nothing for 10 minutes.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, isJustFinished: true, messages }))
            .toBe('error');
    });

    it('is idle when the bot answered after the failure note, such as a resumed turn', () => {
        const messages = [userText(1), systemText('The usage limit was reached. CloudBot continues at 10:00.', 2), assistantText(3)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('idle');
    });

    it('is idle after the note that a secret was saved, which is not a failure', () => {
        const messages = [userText(1), systemText('Saved API_KEY for example.com. Tell the bot to continue.', 2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('idle');
    });

    it('ignores a note from before the owner last wrote', () => {
        const messages = [systemText('The turn stopped because it sent nothing for 10 minutes.', 1), userText(2)];

        expect(deriveMascotState({ ...IDLE_INPUT, messages }))
            .toBe('idle');
    });
});
