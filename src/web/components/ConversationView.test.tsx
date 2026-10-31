// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatMessage, MessageBody } from '../../shared/chatTypes.ts';
import { ConversationView } from './ConversationView.tsx';
import type { ConversationViewProps } from './ConversationView.tsx';
import type * as apiClientTypes from '../apiClient.ts';
import { BUBBLE_DELAY_MS } from '../thinkingBubble.ts';

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
    onOpenScreen: vi.fn(),
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

type ApiClientModule = typeof apiClientTypes;

vi.mock('../apiClient.ts', async importOriginal => ({
    ...(await importOriginal<ApiClientModule>()),
    getBotProvider: vi.fn(() => Promise.resolve({
        provider: 'claude',
        label: 'Claude',
        model: null,
        modelOptions: [],
        selectedModel: null,
        selectedEffort: null,
        effortOptions: [],
    })),
    listProviders: vi.fn(() => Promise.resolve([])),
    getScreenHolder: vi.fn(() => Promise.resolve('bot')),
    takeScreen: vi.fn(() => Promise.resolve('person')),
    releaseScreen: vi.fn(() => Promise.resolve('bot')),
}));

vi.mock('@novnc/novnc', () => ({
    default: class FakeRfb {
        public viewOnly = false;
        public scaleViewport = false;

        public addEventListener(): void {
            // The panel only needs the call to succeed.
        }

        public disconnect(): void {
            // Nothing to release.
        }
    },
}));

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

function historyElement(
    messages: ChatMessage[],
    historyProps: HistoryProps,
    bot?: BotSummary,
    screenRequestId?: number,
    onOpenProfile?: () => void,
    onOpenSetupChat?: (setupBotId: string) => void,
): ReactElement {
    return (
        <ConversationView
            bot={bot}
            messages={messages}
            draftText=""
            isRunning={false}
            actions={noopActions}
            onOpenBotList={vi.fn()}
            onOpenProfile={onOpenProfile}
            onOpenSetupChat={onOpenSetupChat}
            screenRequestId={screenRequestId}
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

    it('keeps the place on screen when a load ends with no older messages and the loading line goes away', () => {
        const messages = [createSequencedMessage(3), createSequencedMessage(4)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder: vi.fn() });
        const messageList = messageListOf(view.container);
        const firstMessage = messageElementOf(view.container, 'm3');

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        // The loading line sits above the first message, so the first message starts 40 pixels down.
        Object.defineProperty(firstMessage, 'offsetTop', { configurable: true, value: 140 });
        Object.defineProperty(firstMessage, 'offsetHeight', { configurable: true, value: 100 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder: vi.fn() }));
        messageList.scrollTop = 100;

        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() }));

        // The empty page ends the load, and the loading line goes away, so the first message moves up 40 pixels.
        Object.defineProperty(firstMessage, 'offsetTop', { configurable: true, value: 100 });
        view.rerender(historyElement([...messages], { hasOlderMessages: false, isLoadingOlder: false }));

        expect(messageList.scrollTop)
            .toBe(60);
    });

    it('does not restore a position across a bot switch, even with a load pending for the first bot', () => {
        const botOne: BotSummary = { id: 'bot-1', name: 'CloudBot', title: 'Coworker', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };
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

    it('has no load button, and says when older messages are loading', () => {
        const loadingView = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder: vi.fn() });

        expect(screen.queryByRole('button', { name: /older messages|Loading/v }))
            .toBeNull();
        expect(loadingView.container.querySelector('.load-older-status')?.textContent)
            .toBe('Loading older messages...');
        loadingView.unmount();

        const doneView = renderWithHistory([createSequencedMessage(3)], { hasOlderMessages: false, onLoadOlder: vi.fn() });

        expect(doneView.container.querySelector('.load-older-status'))
            .toBeNull();
    });

    it('asks for older messages by itself once when the list is too short to scroll', () => {
        const onLoadOlder = vi.fn();
        const messages = [createSequencedMessage(3)];
        const view = renderWithHistory(messages, { hasOlderMessages: true, onLoadOlder });
        const messageList = messageListOf(view.container);

        Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: 800 });
        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 300 });
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder }));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);

        // The load fails, so the oldest message is the same and the list does not ask again.
        view.rerender(historyElement([...messages], { hasOlderMessages: true, isLoadingOlder: true, onLoadOlder }));
        view.rerender(historyElement([...messages], { hasOlderMessages: true, onLoadOlder }));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(1);

        // A page arrives and the list is still short, so it asks for the next one.
        view.rerender(historyElement([createSequencedMessage(2), ...messages], { hasOlderMessages: true, onLoadOlder }));

        expect(onLoadOlder)
            .toHaveBeenCalledTimes(2);
    });
});

describe('ConversationView header', () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    const ana: BotSummary = { id: 'bot-a', name: 'Ana', title: 'Assistant', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'smile', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };

    it('shows the bot profile pill with back and more buttons', () => {
        render(historyElement([], {}, ana));

        expect(screen.getByText('Ana'))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'Open bot profile' }))
            .toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Screen' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Rules' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Routines' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Models' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Delete' }))
            .toBeNull();
        expect(screen.getByRole('button', { name: 'Show bots' }))
            .toBeTruthy();
        expect(screen.getByRole('button', { name: 'More options' }))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));

        expect(screen.getByRole('dialog', { name: 'Conversation options' }))
            .toBeTruthy();
    });

    it('opens the bot profile from the center pill', () => {
        const onOpenProfile = vi.fn();

        render(historyElement([], {}, ana, undefined, onOpenProfile));
        fireEvent.click(screen.getByRole('button', { name: 'Open bot profile' }));

        expect(onOpenProfile)
            .toHaveBeenCalledTimes(1);
    });

    it('keeps model and provider settings inside the More menu', () => {
        const onOpenSetupChat = vi.fn();

        render(historyElement([], {}, ana, undefined, undefined, onOpenSetupChat));
        fireEvent.click(screen.getByRole('button', { name: 'More options' }));

        expect(screen.getByText('Model and provider'))
            .toBeTruthy();
    });

    it('opens the Screen panel when the bot asks for the screen, and Close hides it', async () => {
        vi.stubGlobal('fetch', () => Promise.resolve(Response.json([])));

        const view = render(historyElement([], {}, ana));

        expect(screen.queryByRole('region', { name: 'Bot screen' }))
            .toBeNull();

        view.rerender(historyElement([], {}, ana, 1));

        expect(await screen.findByRole('region', { name: 'Bot screen' }))
            .toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Close' }));

        expect(screen.queryByRole('region', { name: 'Bot screen' }))
            .toBeNull();
    });
});
describe('ConversationView thinking bubble', () => {
    const bot: BotSummary = {
        id: 'bot-1',
        name: 'CloudBot',
        title: 'Helper',
        mascotColor: 'blue',
        mascotShape: 'puff', mascotEyes: 'smile',
        lastMessagePreview: '',
        hasUnread: false, lastMessageSequence: 0,
    };

    function viewWith(options: { isRunning: boolean; draftText: string; activeToolName?: string; messages?: ChatMessage[] }): ReactElement {
        return (
            <ConversationView
                bot={bot}
                messages={options.messages ?? [createMessage('u1', 'user', { kind: 'text', text: 'Hi' })]}
                draftText={options.draftText}
                isRunning={options.isRunning}
                activeToolName={options.activeToolName}
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

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    // The bubble waits BUBBLE_DELAY_MS before it shows, so tests advance the clock past it.
    function renderShown(element: ReactElement): ReturnType<typeof render> {
        const rendered = render(element);

        act(() => {
            vi.advanceTimersByTime(BUBBLE_DELAY_MS);
        });

        return rendered;
    }

    it('shows the status line with a working mascot and a green dot on the header while a turn runs', () => {
        const { container } = renderShown(viewWith({ isRunning: true, draftText: '' }));

        expect(container.querySelector('.message.is-thinking .cloud-mascot')
            ?.getAttribute('data-state'))
            .toBe('working');
        expect(container.querySelector('.bot-pill')
            ?.getAttribute('data-working'))
            .toBe('true');
    });

    it('scrolls the bubble into view when it shows up after the delay', () => {
        const { container } = render(viewWith({ isRunning: true, draftText: '' }));
        const messageList = messageListOf(container);

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 900 });
        act(() => {
            vi.advanceTimersByTime(BUBBLE_DELAY_MS);
        });

        expect(messageList.scrollTop)
            .toBe(900);
    });

    it('does not show the bubble before the delay has passed', () => {
        const { container } = render(viewWith({ isRunning: true, draftText: '' }));

        expect(container.querySelector('.message.is-thinking'))
            .toBeNull();
    });

    it('keeps the status line under a draft reply', () => {
        const { container } = renderShown(viewWith({ isRunning: true, draftText: 'Hello' }));

        expect(container.querySelector('.message.is-draft + .message.is-thinking'))
            .not.toBeNull();
    });

    it('hides the bubble while a field the owner has not sent is open', () => {
        const field = createMessage('f1', 'assistant', { kind: 'secureForm', prompt: 'Add your key', secretName: 'API_KEY', submitted: false });
        const messages = [createMessage('u1', 'user', { kind: 'text', text: 'Hi' }), field];
        const { container } = renderShown(viewWith({ isRunning: true, draftText: '', messages }));

        expect(container.querySelector('.message.is-thinking'))
            .toBeNull();
    });

    it('names the active tool in the bubble', () => {
        const { container } = renderShown(viewWith({ isRunning: true, draftText: '', activeToolName: 'Bash' }));

        expect(container.querySelector('.thinking-line')?.textContent)
            .toBe('Running a command');
    });
});

describe('ConversationView height changes', () => {
    let resizeCallbacks: (() => void)[] = [];

    class FakeResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();

        constructor(callback: () => void) {
            resizeCallbacks.push(callback);
        }
    }

    function resizeList(messageList: HTMLElement, height: number): void {
        Object.defineProperty(messageList, 'clientHeight', { configurable: true, value: height });
        resizeCallbacks.forEach((callback) => {
            callback();
        });
    }

    // Renders a list 1000 pixels tall in a 600 pixel view, with the reader at the given scroll.
    function renderSettled(scrollTop: number): HTMLElement {
        const view = renderWithHistory([createSequencedMessage(1), createSequencedMessage(2)], {});
        const messageList = messageListOf(view.container);

        Object.defineProperty(messageList, 'scrollHeight', { configurable: true, value: 1000 });
        resizeList(messageList, 600);
        messageList.scrollTop = scrollTop;

        return messageList;
    }

    beforeEach(() => {
        resizeCallbacks = [];
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the newest message in view when the keyboard makes the list shorter', () => {
        const messageList = renderSettled(400);

        resizeList(messageList, 300);

        expect(messageList.scrollTop)
            .toBe(1000);
    });

    it('leaves a reader who scrolled up to older messages in place', () => {
        const messageList = renderSettled(100);

        resizeList(messageList, 300);

        expect(messageList.scrollTop)
            .toBe(100);
    });
});
