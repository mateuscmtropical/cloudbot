// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, MessageBody } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';

function createMessage(id: string, role: ChatMessage['role'], body: MessageBody): ChatMessage {
    return { id, botId: 'bot-1', role, createdAt: 1, sequence: 1, body };
}

const allKindMessages: ChatMessage[] = [
    createMessage('m1', 'user', { kind: 'text', text: 'Hi **there**' }),
    createMessage('m2', 'assistant', {
        kind: 'choice',
        prompt: 'Pick a plan',
        options: [{ id: 'free', label: 'Free plan' }],
    }),
    createMessage('m3', 'assistant', {
        kind: 'link',
        text: 'Open the page',
        url: 'https://example.com',
        label: 'Example page',
    }),
    createMessage('m4', 'assistant', {
        kind: 'codeField',
        prompt: 'Enter the code',
        placeholder: '123456',
        submitted: false,
    }),
    createMessage('m5', 'assistant', {
        kind: 'secureForm',
        prompt: 'Add your key',
        secretName: 'API_KEY',
        submitted: false,
    }),
    createMessage('m6', 'system', {
        kind: 'toolActivity',
        toolName: 'Browser',
        status: 'running',
        summary: 'Opening the site',
    }),
];

const noopActions = {
    onChoose: vi.fn(),
    onSubmitCode: vi.fn(),
    onSubmitSecret: vi.fn(),
};

function conversationElement(messages: ChatMessage[], draftText: string): ReactElement {
    return (
        <ConversationView
            bot={undefined}
            messages={messages}
            draftText={draftText}
            isRunning={false}
            actions={noopActions}
            onOpenBotList={vi.fn()}
            onSend={vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
        />
    );
}

function renderConversation(messages: ChatMessage[]): void {
    render(conversationElement(messages, ''));
}

describe('ConversationView message list', () => {
    afterEach(() => {
        cleanup();
    });

    it('shows the draft text as an assistant bubble until the finished message replaces it', () => {
        const view = render(conversationElement([], 'Partial **reply**'));

        expect(screen.getByText('reply').tagName)
            .toBe('STRONG');
        expect(view.container.querySelector('.message-assistant.is-draft'))
            .not.toBeNull();

        view.rerender(conversationElement([createMessage('m7', 'assistant', { kind: 'text', text: 'Partial reply' })], ''));

        expect(view.container.querySelector('.is-draft'))
            .toBeNull();
        expect(screen.getByText('Partial reply'))
            .toBeTruthy();
    });

    it('renders every message kind', () => {
        renderConversation(allKindMessages);

        expect(screen.getByText('there').tagName)
            .toBe('STRONG');
        expect(screen.getByRole('button', { name: 'Free plan' }))
            .toBeTruthy();
        expect(screen.getByRole('link', { name: 'Example page' })
            .getAttribute('href'))
            .toBe('https://example.com');
        expect(screen.getByPlaceholderText('123456'))
            .toBeTruthy();
        expect(screen.getByLabelText('API_KEY'))
            .toBeTruthy();
        expect(screen.getByText('Opening the site'))
            .toBeTruthy();
    });

    it('aligns user messages to the right with the user class', () => {
        renderConversation(allKindMessages);

        const userMessage = screen.getByText('there')
            .closest('.message');

        expect(userMessage?.className)
            .toContain('message-user');
    });
});
