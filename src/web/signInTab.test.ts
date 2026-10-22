import { describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessageBody } from '../shared/chatTypes.ts';
import { settleSignInTab } from './signInTab.ts';

function message(sequence: number, body: MessageBody): ChatMessage {
    return { id: `m${String(sequence)}`, botId: 'bot', role: 'assistant', body, sequence, createdAt: 0 };
}

function fakeTab(): { tab: Window; close: ReturnType<typeof vi.fn> } {
    const close = vi.fn();

    return { tab: { location: { href: '' }, close } as unknown as Window, close };
}

describe('settleSignInTab', () => {
    it('puts the sign-in link from a newer message in the tab', () => {
        const { tab } = fakeTab();
        const messages = [
            message(1, { kind: 'link', text: 'Old', label: 'Old', url: 'https://old.example/login' }),
            message(2, { kind: 'text', text: 'Signing in.' }),
            message(3, { kind: 'link', text: 'Sign in.', label: 'Sign in to Gemini', url: 'https://accounts.google.com/o/oauth2' }),
        ];

        expect(settleSignInTab({ tab, afterSequence: 1 }, messages))
            .toBe(true);
        expect(tab.location.href)
            .toBe('https://accounts.google.com/o/oauth2');
    });

    it('waits while only text came, and closes the tab when the server asks something else', () => {
        const { tab, close } = fakeTab();
        const signInTab = { tab, afterSequence: 0 };

        expect(settleSignInTab(signInTab, [message(1, { kind: 'text', text: 'One moment.' })]))
            .toBe(false);
        expect(settleSignInTab(signInTab, [message(1, { kind: 'choice', prompt: 'Which AI provider?', options: [] })]))
            .toBe(true);
        expect(close)
            .toHaveBeenCalledOnce();
    });

    it('never opens a link that is not safe', () => {
        const { tab, close } = fakeTab();

        expect(settleSignInTab({ tab, afterSequence: 0 }, [message(1, { kind: 'link', text: 'x', label: 'x', url: 'javascript:alert(1)' })]))
            .toBe(false);
        expect(tab.location.href)
            .toBe('');
        expect(close)
            .not.toHaveBeenCalled();
    });
});
