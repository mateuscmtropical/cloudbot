// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatMessage, MessageBody } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';
import type { ConversationViewProps } from './ConversationView.tsx';

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
    onChoose: vi.fn(() => Promise.resolve()),
    onSubmitCode: vi.fn(),
    onSubmitSecret: vi.fn(() => Promise.resolve()),
};

function conversationElement(messages: ChatMessage[], draftText: string): ReactElement {
    return (
        <ConversationView
            bot={undefined}
            messages={messages}
            draftText={draftText}
            isRunning={false}
            attachments={[]}
            isUploading={false}
            onRemoveAttachment={vi.fn()}
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
    it('lists the files attached to a user message under its text', () => {
        renderConversation([
            createMessage('m7', 'user', {
                kind: 'text',
                text: 'Read this',
                attachments: [{ name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5 }],
            }),
        ]);

        expect(screen.getByText('notes.txt').className)
            .toBe('attachment-item');
    });
});

function createSequencedMessage(sequence: number): ChatMessage {
    const message = createMessage(`m${String(sequence)}`, 'user', { kind: 'text', text: `message ${String(sequence)}` });

    return { ...message, sequence };
}

type HistoryProps = Pick<ConversationViewProps, 'hasOlderMessages' | 'isLoadingOlder' | 'onLoadOlder'>;

function historyElement(messages: ChatMessage[], historyProps: HistoryProps, bot?: BotSummary): ReactElement {
    return (
        <ConversationView
            bot={bot}
            messages={messages}
            draftText=""
            isRunning={false}
            actions={noopActions}
            onOpenBotList={vi.fn()}
            onSend={vi.fn()}
            onStop={vi.fn()}
            onAttach={vi.fn()}
            attachments={[]}
            isUploading={false}
            onRemoveAttachment={vi.fn()}
            {...historyProps}
        />
    );
}

function renderWithHistory(messages: ChatMessage[], historyProps: HistoryProps): ReturnType<typeof render> {
    return render(historyElement(messages, historyProps));
}

function messageElementOf(container: HTMLElement, messageId: string): HTMLElement {
    const messageElement = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);

    if (messageElement === null) {
        throw new Error('The message element is missing');
    }

    return messageElement;
}

function messageListOf(container: HTMLElement): HTMLElement {
    const messageList = container.querySelector<HTMLElement>('.message-list');

    if (messageList === null) {
        throw new Error('The message list is missing');
    }

    return messageList;
}

describe('ConversationView older messages', () => {
    afterEach(() => {
        cleanup();
    });

    it('asks for older messages when the list is scrolled to the top', () => {
        const onLoadOlder = vi.fn();
        const view = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, onLoadOlder });

        fireEvent.scroll(messageListOf(view.container), { target: { scrollTop: 0 } });

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);
    });

    it('does not ask for older messages when the list is not at the top', () => {
        const onLoadOlder = vi.fn();
        const view = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, onLoadOlder });

        fireEvent.scroll(messageListOf(view.container), { target: { scrollTop: 500 } });

        expect(onLoadOlder)
            .not.toHaveBeenCalled();
    });

    it('does not ask for older messages when there are none, or while a page is loading', () => {
        const onLoadOlder = vi.fn();
        const noOlderView = renderWithHistory([createSequencedMessage(1)], { hasOlderMessages: false, onLoadOlder });

        fireEvent.scroll(messageListOf(noOlderView.container), { target: { scrollTop: 0 } });
        noOlderView.unmount();

        const loadingView = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder });

        fireEvent.scroll(messageListOf(loadingView.container), { target: { scrollTop: 0 } });

        expect(onLoadOlder)
            .not.toHaveBeenCalled();
    });

    it('keeps the reader on the same message when older messages are added above', () => {
        const newerMessages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = renderWithHistory(newerMessages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);

        // Settle the list at a known height first, so the next change is measured from it.
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        view.rerender(
            <ConversationView
                bot={undefined}
                messages={[...newerMessages]}
                draftText=""
                isRunning={false}
                actions={noopActions}
                hasOlderMessages
                onOpenBotList={vi.fn()}
                onSend={vi.fn()}
                onStop={vi.fn()}
                onAttach={vi.fn()}
                attachments={[]}
                isUploading={false}
                onRemoveAttachment={vi.fn()}
            />,
        );

        // The reader scrolls to the top and an older page is requested. The first message is the anchor.
        const anchorElement = messageElementOf(view.container, 'm3');

        Object.defineProperty(anchorElement, 'offsetTop', { configurable: true, value: 0 });
        Object.defineProperty(anchorElement, 'offsetHeight', { configurable: true, value: 100 });
        messageList.scrollTop = 0;
        view.rerender(historyElement([...newerMessages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        // The page adds 300 pixels above, so the anchor moves down by 300.
        Object.defineProperty(anchorElement, 'offsetTop', { configurable: true, value: 300 });
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1300 });
        view.rerender(
            <ConversationView
                bot={undefined}
                messages={[createSequencedMessage(1), createSequencedMessage(2), ...newerMessages]}
                draftText=""
                isRunning={false}
                actions={noopActions}
                hasOlderMessages
                onOpenBotList={vi.fn()}
                onSend={vi.fn()}
                onStop={vi.fn()}
                onAttach={vi.fn()}
                attachments={[]}
                isUploading={false}
                onRemoveAttachment={vi.fn()}
            />,
        );

        expect(messageList.scrollTop)
            .toBe(300);
    });

    it('does not scroll to the bottom while an older page loads', () => {
        const messages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);

        // Settle the list at a known height, then the reader scrolls to the top.
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder: vi.fn() }));
        messageList.scrollTop = 0;

        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        expect(messageList.scrollTop)
            .toBe(0);
    });

    it('keeps the anchored message in place when older messages and growth below arrive in one render', () => {
        const messages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);
        const anchorElement = messageElementOf(view.container, 'm3');

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(anchorElement, 'offsetTop', { configurable: true, value: 100 });
        Object.defineProperty(anchorElement, 'offsetHeight', { configurable: true, value: 100 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder: vi.fn() }));
        messageList.scrollTop = 0;

        // The load starts with the anchor 100 pixels down the list, and the reader at the top.
        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        // A message arrives at the bottom while loading, and the reader is still at the top.
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1100 });
        view.rerender(historyElement([...messages, createSequencedMessage(5)], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        expect(messageList.scrollTop)
            .toBe(0);

        // One render adds two messages above, which move the anchor down to 300, and one more below.
        Object.defineProperty(anchorElement, 'offsetTop', { configurable: true, value: 300 });
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1500 });
        view.rerender(historyElement([createSequencedMessage(1), createSequencedMessage(2), ...messages, createSequencedMessage(5), createSequencedMessage(6)], { hasOlderMessages: true, isLoadingOlder: false, onLoadOlder: vi.fn() }));

        // The anchor was 100 pixels from the top at the start of the load, so the view moves to 300 - 100.
        expect(messageList.scrollTop)
            .toBe(200);
    });

    it('follows new messages only while the reader is near the bottom', () => {
        const view = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: false });
        const messageList = messageListOf(view.container);

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        view.rerender(historyElement([createSequencedMessage(3)], { hasOlderMessages: false }));

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1100 });
        view.rerender(historyElement([createSequencedMessage(3), createSequencedMessage(4)], { hasOlderMessages: false }));

        expect(messageList.scrollTop)
            .toBe(1100);

        // The reader scrolls up, so a new message leaves the position alone.
        messageList.scrollTop = 200;
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1200 });
        view.rerender(historyElement([createSequencedMessage(3), createSequencedMessage(4), createSequencedMessage(5)], { hasOlderMessages: false }));

        expect(messageList.scrollTop)
            .toBe(200);
    });

    it('keeps the reader where they scrolled to during a slow load', () => {
        const messages = [createSequencedMessage(3), createSequencedMessage(4), createSequencedMessage(5), createSequencedMessage(6)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);
        const messageElements = ['m3', 'm4', 'm5', 'm6'].map(messageId => messageElementOf(view.container, messageId));

        // Four messages, 200 pixels each, with tops at 0, 200, 400 and 600.
        messageElements.forEach((element, index) => {
            Object.defineProperty(element, 'offsetTop', { configurable: true, value: index * 200 });
            Object.defineProperty(element, 'offsetHeight', { configurable: true, value: 200 });
        });
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        messageList.scrollTop = 0;
        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        // The reader scrolls down 400 pixels while the page is still loading.
        messageList.scrollTop = 400;
        fireEvent.scroll(messageList);

        // The page adds 400 pixels above, so every message moves down by 400.
        messageElements.forEach((element, index) => {
            Object.defineProperty(element, 'offsetTop', { configurable: true, value: index * 200 + 400 });
        });
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1400 });
        view.rerender(historyElement([createSequencedMessage(1), createSequencedMessage(2), ...messages], { hasOlderMessages: true, isLoadingOlder: false, onLoadOlder: vi.fn() }));

        // The message that was at the top of the screen is still at the top, so the view is at 800.
        expect(messageList.scrollTop)
            .toBe(800);
    });

    it('scrolls to the bottom when older messages arrive without an anchor and the reader is near the bottom', () => {
        const messages = [createSequencedMessage(60), createSequencedMessage(61)];
        const view = renderWithHistory(messages, { hasOlderMessages: false });
        const messageList = messageListOf(view.container);

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        view.rerender(historyElement([...messages], { hasOlderMessages: false }));

        // A reload adds older messages to a list that only held messages from the stream.
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1300 });
        view.rerender(historyElement([createSequencedMessage(1), ...messages], { hasOlderMessages: false }));

        expect(messageList.scrollTop)
            .toBe(1300);
    });

    it('keeps the place on screen when a load ends with no older messages and the button goes away', () => {
        const messages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);
        const firstMessage = messageElementOf(view.container, 'm3');

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        // The load button sits above the first message, so the first message starts 40 pixels down.
        Object.defineProperty(firstMessage, 'offsetTop', { configurable: true, value: 140 });
        Object.defineProperty(firstMessage, 'offsetHeight', { configurable: true, value: 100 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder: vi.fn() }));
        messageList.scrollTop = 100;

        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        // The empty page ends the load, and the button goes away, so the first message moves up 40 pixels.
        Object.defineProperty(firstMessage, 'offsetTop', { configurable: true, value: 100 });
        view.rerender(historyElement([...messages], { hasOlderMessages: false, isLoadingOlder: false }));

        expect(messageList.scrollTop)
            .toBe(60);
    });

    it('does not restore a position across a bot switch, even with a load pending for the first bot', () => {
        const botOne: BotSummary = { id: 'bot-1', name: 'CloudBot', title: 'Coworker', avatarColor: '#336699', lastMessagePreview: '', hasUnread: false };
        const botTwo: BotSummary = { ...botOne, id: 'bot-2', name: 'Ana' };
        const messages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = render(historyElement(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() }, botOne));
        const messageList = messageListOf(view.container);

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder: vi.fn() }, botOne));
        messageList.scrollTop = 0;
        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }, botOne));

        // The reader switches to another bot whose messages are older. The view goes to that bot's bottom.
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1500 });
        view.rerender(historyElement([createSequencedMessage(1), createSequencedMessage(2)], { hasOlderMessages: true, onLoadOlder: vi.fn() }, botTwo));

        expect(messageList.scrollTop)
            .toBe(1500);
    });

    it('shows a load button at the top when older messages exist and no load is running', () => {
        const onLoadOlder = vi.fn();

        renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, onLoadOlder });

        fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);
    });

    it('shows a disabled Loading button while a load runs, and no button when nothing is older', () => {
        const loadingView = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() });

        const loadingButton = screen.getByRole('button', { name: 'Loading...' });

        expect(loadingButton.getAttribute('disabled'))
            .not.toBeNull();
        loadingView.unmount();

        renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: false, onLoadOlder: vi.fn() });

        expect(screen.queryByRole('button', { name: 'Load older messages' }))
            .toBeNull();
    });
});
