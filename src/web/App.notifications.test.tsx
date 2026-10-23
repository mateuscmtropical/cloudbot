// @vitest-environment happy-dom
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatMessage } from '../shared/chatTypes.ts';
import { App } from './App.tsx';
import { listBots, listMessages, listUploads, submitChoice, subscribeToEvents } from './apiClient.ts';
import { disablePushNotifications, enablePushNotifications } from './pushClient.ts';
import type * as PushClientModule from './pushClient.ts';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 15000 });

vi.mock('./apiClient.ts', () => ({
    RequestFailedError: class RequestFailedError extends Error {
        serverMessage: string | undefined;
    },
    listBots: vi.fn(),
    listChannels: vi.fn(() => Promise.resolve([])),
    getChannel: vi.fn(),
    postChannelMessage: vi.fn(),
    stopChannel: vi.fn(),
    getScreenHolder: vi.fn(() => Promise.resolve('bot')),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    stopTurn: vi.fn(),
    submitChoice: vi.fn(),
    submitCode: vi.fn(),
    submitSecret: vi.fn(),
    subscribeToEvents: vi.fn(),
    uploadAttachments: vi.fn(),
    listUploads: vi.fn(() => Promise.resolve([])),
    removeUpload: vi.fn(),
}));

vi.mock('./peopleClient.ts', () => ({
    listPeople: vi.fn(() => Promise.reject(new Error('People route is not available.'))),
}));

// Only the permission and subscription step is replaced. The helpers of the module stay real.
vi.mock('./pushClient.ts', async (importOriginal) => {
    const original = await importOriginal<typeof PushClientModule>();

    return { ...original, enablePushNotifications: vi.fn(), disablePushNotifications: vi.fn() };
});

function createBot(name: string, id: string): BotSummary {
    return { id, name, title: 'Coworker', mascotColor: 'blue', mascotShape: 'puff', lastMessagePreview: '', hasUnread: false };
}

const CARD: ChatMessage = {
    id: 'card-1',
    botId: 'bot-1',
    role: 'assistant',
    createdAt: 1,
    sequence: 1,
    body: {
        kind: 'choice',
        prompt: 'I can send a notification to this browser.',
        options: [{ id: 'enable', label: 'Turn on notifications' }, { id: 'later', label: 'Not now' }],
        isNotificationOptIn: true,
    },
};

const OFF_CARD: ChatMessage = {
    id: 'card-2',
    botId: 'bot-1',
    role: 'assistant',
    createdAt: 2,
    sequence: 2,
    body: {
        kind: 'choice',
        prompt: 'I can stop the notifications on this browser.',
        options: [{ id: 'disable', label: 'Turn off notifications' }, { id: 'keep', label: 'Keep them' }],
        isNotificationOptOut: true,
    },
};

function openConversation(bots: BotSummary[], messages: ChatMessage[]): void {
    vi.mocked(listBots)
        .mockResolvedValue(bots);
    vi.mocked(listMessages)
        .mockResolvedValue(messages);
    vi.mocked(listUploads)
        .mockResolvedValue([]);
    // The messages load when the event stream opens, so the fake opens it at once.
    vi.mocked(subscribeToEvents)
        .mockImplementation((_botId, _onEvent, onOpen) => {
            onOpen();

            return () => {};
        });
}

function selectedBotName(): string | null | undefined {
    return document.querySelector('.bot-item.is-selected .bot-name')?.textContent;
}

beforeEach(() => {
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    cleanup();
    vi.mocked(enablePushNotifications)
        .mockReset();
    vi.mocked(disablePushNotifications)
        .mockReset();
    vi.mocked(submitChoice)
        .mockReset();
    Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('App notification card', () => {
    it('turns notifications on from the tap and then answers the card', async () => {
        openConversation([createBot('Ana', 'bot-1')], [CARD]);
        vi.mocked(enablePushNotifications)
            .mockResolvedValue('enabled');
        vi.mocked(submitChoice)
            .mockResolvedValue({ ...CARD, body: { ...CARD.body, chosenId: 'enable' } as ChatMessage['body'] });

        render(<App />);

        const button = await screen.findByText('Turn on notifications');

        fireEvent.click(button);

        // The browser prompt starts inside the click itself, before any await.
        expect(enablePushNotifications)
            .toHaveBeenCalledTimes(1);
        await waitFor(() => {
            expect(submitChoice)
                .toHaveBeenCalledWith('bot-1', 'card-1', 'enable');
        });
    });

    it('keeps the card open and says why when the browser blocks notifications', async () => {
        openConversation([createBot('Ana', 'bot-1')], [CARD]);
        vi.mocked(enablePushNotifications)
            .mockResolvedValue('blocked');

        render(<App />);
        fireEvent.click(await screen.findByText('Turn on notifications'));

        const alert = await screen.findByRole('alert');

        expect(alert.textContent)
            .toContain('blocked for this site');
        expect(submitChoice)
            .not.toHaveBeenCalled();
    });

    it('shows the problem when the server refuses the subscription', async () => {
        openConversation([createBot('Ana', 'bot-1')], [CARD]);
        vi.mocked(enablePushNotifications)
            .mockRejectedValue(new Error('refused'));

        render(<App />);
        fireEvent.click(await screen.findByText('Turn on notifications'));

        const alert = await screen.findByRole('alert');

        expect(alert.textContent)
            .toContain('Could not turn on notifications');
        expect(submitChoice)
            .not.toHaveBeenCalled();
    });

    it('answers "Not now" without asking the browser for anything', async () => {
        openConversation([createBot('Ana', 'bot-1')], [CARD]);
        vi.mocked(submitChoice)
            .mockResolvedValue({ ...CARD, body: { ...CARD.body, chosenId: 'later' } as ChatMessage['body'] });

        render(<App />);
        fireEvent.click(await screen.findByText('Not now'));

        await waitFor(() => {
            expect(submitChoice)
                .toHaveBeenCalledWith('bot-1', 'card-1', 'later');
        });
        expect(enablePushNotifications)
            .not.toHaveBeenCalled();
    });
});

describe('App notification off card', () => {
    it('removes this browser first and then answers the card', async () => {
        openConversation([createBot('Ana', 'bot-1')], [OFF_CARD]);
        vi.mocked(disablePushNotifications)
            .mockResolvedValue(undefined);
        vi.mocked(submitChoice)
            .mockResolvedValue({ ...OFF_CARD, body: { ...OFF_CARD.body, chosenId: 'disable' } as ChatMessage['body'] });

        render(<App />);
        fireEvent.click(await screen.findByText('Turn off notifications'));

        expect(disablePushNotifications)
            .toHaveBeenCalledTimes(1);
        await waitFor(() => {
            expect(submitChoice)
                .toHaveBeenCalledWith('bot-1', 'card-2', 'disable');
        });
        expect(enablePushNotifications)
            .not.toHaveBeenCalled();
    });

    it('keeps the card open and says so when the browser could not be removed', async () => {
        openConversation([createBot('Ana', 'bot-1')], [OFF_CARD]);
        vi.mocked(disablePushNotifications)
            .mockRejectedValue(new Error('offline'));

        render(<App />);
        fireEvent.click(await screen.findByText('Turn off notifications'));

        const alert = await screen.findByRole('alert');

        expect(alert.textContent)
            .toContain('Could not turn off notifications');
        expect(submitChoice)
            .not.toHaveBeenCalled();
    });

    it('answers "Keep them" without touching the browser', async () => {
        openConversation([createBot('Ana', 'bot-1')], [OFF_CARD]);
        vi.mocked(submitChoice)
            .mockResolvedValue({ ...OFF_CARD, body: { ...OFF_CARD.body, chosenId: 'keep' } as ChatMessage['body'] });

        render(<App />);
        fireEvent.click(await screen.findByText('Keep them'));

        await waitFor(() => {
            expect(submitChoice)
                .toHaveBeenCalledWith('bot-1', 'card-2', 'keep');
        });
        expect(disablePushNotifications)
            .not.toHaveBeenCalled();
    });
});

describe('App notification links', () => {
    it('opens the bot that the address names', async () => {
        window.history.replaceState(null, '', '/?bot=bot-2&message=m9');
        openConversation([createBot('Ana', 'bot-1'), createBot('Ben', 'bot-2')], []);

        render(<App />);

        await waitFor(() => {
            expect(selectedBotName())
                .toBe('Ben');
        });
    });

    it('opens the first bot when the address names a bot that does not exist', async () => {
        window.history.replaceState(null, '', '/?bot=gone');
        openConversation([createBot('Ana', 'bot-1'), createBot('Ben', 'bot-2')], []);

        render(<App />);

        await waitFor(() => {
            expect(selectedBotName())
                .toBe('Ana');
        });
    });

    it('writes the open bot into the address and drops the message part', async () => {
        window.history.replaceState(null, '', '/?bot=bot-2&message=m9');
        openConversation([createBot('Ana', 'bot-1'), createBot('Ben', 'bot-2')], []);

        render(<App />);

        await waitFor(() => {
            expect(window.location.search)
                .toBe('?bot=bot-2');
        });

        const first = await screen.findByText('Ana');

        fireEvent.click(first);

        await waitFor(() => {
            expect(window.location.search)
                .toBe('?bot=bot-1');
        });
    });

    it('switches to the bot that a tapped notification names while the app is open', async () => {
        const container = Object.assign(new EventTarget(), { startMessages: vi.fn() });

        Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
        openConversation([createBot('Ana', 'bot-1'), createBot('Ben', 'bot-2')], []);

        render(<App />);

        await waitFor(() => {
            expect(selectedBotName())
                .toBe('Ana');
        });

        act(() => {
            container.dispatchEvent(new MessageEvent('message', { data: { type: 'openBot', botId: 'bot-2', messageId: 'm9' } }));
        });

        await waitFor(() => {
            expect(selectedBotName())
                .toBe('Ben');
        });
    });

    it('ignores a tapped notification for a bot that is not in the list', async () => {
        const container = Object.assign(new EventTarget(), { startMessages: vi.fn() });

        Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
        openConversation([createBot('Ana', 'bot-1')], []);

        render(<App />);

        await waitFor(() => {
            expect(selectedBotName())
                .toBe('Ana');
        });

        act(() => {
            container.dispatchEvent(new MessageEvent('message', { data: { type: 'openBot', botId: 'unknown' } }));
        });

        expect(selectedBotName())
            .toBe('Ana');
    });
});
