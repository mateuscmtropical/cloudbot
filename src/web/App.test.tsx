// @vitest-environment happy-dom
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatEvent, ChatMessage, PendingUpload } from '../shared/chatTypes.ts';
import { App } from './App.tsx';
import { listBots, listMessages, listUploads, RequestFailedError, sendMessage, stopTurn, subscribeToEvents, uploadAttachments } from './apiClient.ts';
import { MESSAGE_PAGE_SIZE } from './messageList.ts';
import { getHubContext } from './peopleClient.ts';

// The waits below end when the state appears. The longer limit only covers slow runs with the whole suite in parallel.
configure({ asyncUtilTimeout: 5000 });
// Under the parallel full run, each test here can take more than the 5 s default.
vi.setConfig({ testTimeout: 15000 });

function getBotListHeaderButton(label: string): HTMLElement {
    const botList = screen.getByRole('complementary', { name: 'Bots' });
    const botListQueries = within(botList);
    const button = botListQueries.getByRole('button', { name: label });

    return button;
}

vi.mock('./apiClient.ts', () => ({
    // A stand-in class, so `instanceof` checks in the app have something to test against.
    RequestFailedError: class RequestFailedError extends Error {},
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
    subscribeToAllBotEvents: vi.fn(() => () => undefined),
    uploadAttachments: vi.fn(),
    listUploads: vi.fn(() => Promise.resolve([])),
    // The provider picker in the header reads the provider. These tests have none.
    getBotProvider: vi.fn(() => Promise.reject(new Error('Provider route is not available.'))),
    listProviders: vi.fn(() => Promise.resolve([])),
    startProviderConnect: vi.fn(),
    switchBotProvider: vi.fn(),
    renameBot: vi.fn(),
    removeUpload: vi.fn(),
    listConnectedApps: vi.fn(() => Promise.resolve([])),
    removeConnectedApp: vi.fn(() => Promise.resolve()),
    startAppConnection: vi.fn(),
}));

vi.mock('./peopleClient.ts', () => ({
    getHubContext: vi.fn(() => Promise.resolve({ role: 'standalone' })),
    listPeople: vi.fn(() => Promise.resolve([])),
}));

function createBot(name: string, id = 'bot-1'): BotSummary {
    return {
        id,
        name,
        title: 'Coworker',
        mascotColor: 'blue', mascotShape: 'puff',
        lastMessagePreview: '',
        hasUnread: false, lastMessageSequence: 0,
    };
}

function renderedBotName(): string | null | undefined {
    return document.querySelector('.bot-name')?.textContent;
}

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.querySelectorAll('[data-tab-icon]')
        .forEach((tabIcon) => {
            tabIcon.remove();
        });
});

describe('App sign-in', () => {
    it('shows the passkey sign-in when there is no session', async () => {
        const noSession = Object.assign(new RequestFailedError('/api/bots', 401), { status: 401 });

        vi.mocked(listBots)
            .mockRejectedValueOnce(noSession);

        render(<App />);

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Sign in with a passkey' }))
                .toBeDefined();
        });
    });
});

describe('App bot list', () => {
    it('opens Bot Profile from the header pill and returns to the hidden chat', async () => {
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockReturnValue(() => undefined);

        render(<App />);

        await screen.findByRole('textbox');
        fireEvent.click(screen.getByRole('button', { name: 'Open bot profile' }));

        expect(await screen.findByRole('heading', { name: 'CloudBot' }))
            .toBeTruthy();
        expect(screen.queryByRole('textbox'))
            .toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));

        expect(await screen.findByRole('textbox'))
            .toBeTruthy();
    });

    it('tells the owner of a CloudBot that runs on its own to install a hub', async () => {
        vi.mocked(listBots)
            .mockResolvedValue([]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);

        render(<App />);

        await waitFor(() => {
            expect(getHubContext)
                .toHaveBeenCalledTimes(1);
        });

        fireEvent.click(getBotListHeaderButton('People'));

        expect(await screen.findByText('This CloudBot runs on its own'))
            .toBeTruthy();
        expect(screen.queryByRole('textbox'))
            .toBeNull();
    });

    it('opens the account panel for a person of a hub and hides it elsewhere', async () => {
        vi.mocked(getHubContext)
            .mockResolvedValueOnce({ role: 'member', personName: 'Maria Regina' });
        vi.mocked(listBots)
            .mockResolvedValue([]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);

        render(<App />);

        fireEvent.click(getBotListHeaderButton('Account'));

        expect(await screen.findByRole('heading', { name: 'Account' }))
            .toBeTruthy();
    });

    it('replaces the chat while the account panel is open', async () => {
        vi.mocked(getHubContext)
            .mockResolvedValueOnce({ role: 'member', personName: 'Maria Regina' });
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockReturnValue(() => undefined);

        render(<App />);

        expect(await screen.findByRole('textbox'))
            .toBeTruthy();

        fireEvent.click(getBotListHeaderButton('Account'));

        expect(await screen.findByRole('heading', { name: 'Account' }))
            .toBeTruthy();
        expect(screen.queryByRole('textbox'))
            .toBeNull();
    });

    it('offers only the notifications in the account panel of a CloudBot that runs without a hub', async () => {
        vi.mocked(listBots)
            .mockResolvedValue([]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);

        render(<App />);

        await waitFor(() => {
            expect(getHubContext)
                .toHaveBeenCalled();
        });
        fireEvent.click(getBotListHeaderButton('Account'));

        expect(await screen.findByRole('switch', { name: 'Notifications on this device' }))
            .toBeTruthy();
        expect(screen.queryByRole('link', { name: 'Change password' }))
            .toBeNull();
    });

    it('tells a person of a hub to ask the owner', async () => {
        vi.mocked(getHubContext)
            .mockResolvedValueOnce({ role: 'member', personName: 'Maria Regina' });
        vi.mocked(listBots)
            .mockResolvedValue([]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);

        render(<App />);

        await waitFor(() => {
            expect(getHubContext)
                .toHaveBeenCalled();
        });
        fireEvent.click(getBotListHeaderButton('Account'));
        fireEvent.click(getBotListHeaderButton('People'));

        expect(await screen.findByText('Only the owner of the hub adds people'))
            .toBeTruthy();
    });

    it('opens the people panel for the owner of a hub', async () => {
        vi.mocked(getHubContext)
            .mockResolvedValue({ role: 'owner', personName: 'Mateus Silva' });
        vi.mocked(listBots)
            .mockResolvedValue([]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);

        render(<App />);

        fireEvent.click(getBotListHeaderButton('Account'));
        fireEvent.click(getBotListHeaderButton('People'));

        expect(await screen.findByRole('heading', { name: 'People' }))
            .toBeTruthy();
    });

    it('reloads the bot list when a turn ends so a renamed bot shows its new name', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValueOnce([createBot('CloudBot')])
            .mockResolvedValueOnce([createBot('Ana')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handler exists.
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: true });
        });

        expect(listBots)
            .toHaveBeenCalledTimes(1);

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('Ana');
        });
        expect(listBots)
            .toHaveBeenCalledTimes(2);
    });

    it('reloads the pending files when a turn ends, so files put back by a stopped turn show up', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'upload-9', name: 'notes.txt', sizeBytes: 5 }]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handler exists.
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: true });
        });

        expect(listUploads)
            .toHaveBeenCalledTimes(1);

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        await waitFor(() => {
            expect(screen.getByText('notes.txt'))
                .toBeTruthy();
        });
        expect(listUploads)
            .toHaveBeenCalledTimes(2);
    });
});

describe('App quiet check-ins', () => {
    it('drops the messages the server removed and keeps the others', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };
        const makeMessage = (id: string, text: string, sequence: number): ChatMessage => ({
            id, botId: 'bot-1', role: 'user', createdAt: sequence, sequence, body: { kind: 'text', text },
        });

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'message', message: makeMessage('m1', 'Hello there', 1) });
            emitEvent.current?.({ type: 'message', message: makeMessage('m2', 'Check-in look', 2) });
        });

        await waitFor(() => {
            expect(container.textContent)
                .toContain('Check-in look');
        });

        act(() => {
            emitEvent.current?.({ type: 'messagesRemoved', botId: 'bot-1', messageIds: ['m2'] });
        });

        expect(container.textContent)
            .not.toContain('Check-in look');
        expect(container.textContent)
            .toContain('Hello there');
    });
});

describe('App pending files', () => {
    it('clears the attached files error after a later list succeeds', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockRejectedValueOnce(new Error('instance is starting'))
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);

        expect(await screen.findByText('Could not load the attached files.'))
            .toBeTruthy();

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        await waitFor(() => {
            expect(screen.queryByText('Could not load the attached files.'))
                .toBeNull();
        });
    });

    it('lets the owner dismiss the attached files error', async () => {
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockRejectedValueOnce(new Error('instance is starting'));

        render(<App />);

        expect(await screen.findByText('Could not load the attached files.'))
            .toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));

        expect(screen.queryByText('Could not load the attached files.'))
            .toBeNull();
    });

    it('keeps a restored file when the send response arrives after the turn-end list', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };
        const notes: PendingUpload = { id: 'server-1', name: 'notes.txt', sizeBytes: 5 };
        const sentMessage: ChatMessage = {
            id: 'm1',
            botId: 'bot-1',
            role: 'user',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'text', text: 'Read this' },
        };
        let resolveSend: (message: ChatMessage) => void = () => {};
        const sendResult = new Promise<ChatMessage>((resolve) => {
            resolveSend = resolve;
        });

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockResolvedValueOnce([notes])
            .mockResolvedValueOnce([notes])
            .mockResolvedValueOnce([notes]);
        vi.mocked(sendMessage)
            .mockReturnValueOnce(sendResult);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);

        await waitFor(() => {
            expect(screen.getByText('notes.txt'))
                .toBeTruthy();
        });

        const textarea = screen.getByPlaceholderText('Ask CloudBot...');

        fireEvent.change(textarea, { target: { value: 'Read this' } });
        fireEvent.keyDown(textarea, { key: 'Enter' });

        // The turn ends first and puts the file back. Its list is applied.
        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        await waitFor(() => {
            expect(listUploads)
                .toHaveBeenCalledTimes(2);
        });

        // The send response comes last. It must not hide the file.
        act(() => {
            resolveSend(sentMessage);
        });

        await waitFor(() => {
            expect(listUploads)
                .toHaveBeenCalledTimes(3);
        });
        expect(screen.getByText('notes.txt'))
            .toBeTruthy();
    });

    it('ignores a pending list issued before a newer one, so a fresh upload stays visible', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };
        let resolveStale: (uploads: PendingUpload[]) => void = () => {};
        const staleList = new Promise<PendingUpload[]>((resolve) => {
            resolveStale = resolve;
        });

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockResolvedValueOnce([])
            .mockReturnValueOnce(staleList)
            .mockResolvedValueOnce([{ id: 'fresh-1', name: 'fresh.txt', sizeBytes: 5 }]);
        vi.mocked(uploadAttachments)
            .mockResolvedValueOnce(undefined);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handler exists.
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        // A turn ends, and its list request is still in flight when the upload happens.
        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

        fireEvent.change(fileInput, { target: { files: [new File(['hello'], 'fresh.txt')] } });

        await waitFor(() => {
            expect(screen.getByText('fresh.txt'))
                .toBeTruthy();
        });

        // The older list arrives late with nothing in it. It must not hide the fresh file.
        act(() => {
            resolveStale([]);
        });

        expect(screen.getByText('fresh.txt'))
            .toBeTruthy();
        expect(listUploads)
            .toHaveBeenCalledTimes(3);
    });

    it('shows a file the server queued even when the upload response failed', async () => {
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(listUploads)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'queued-1', name: 'queued.txt', sizeBytes: 5 }]);
        vi.mocked(uploadAttachments)
            .mockRejectedValueOnce(new Error('connection lost'));
        vi.mocked(subscribeToEvents)
            .mockImplementation(() => () => {});

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });

        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

        fireEvent.change(fileInput, { target: { files: [new File(['hello'], 'queued.txt')] } });

        await waitFor(() => {
            expect(screen.getByText('queued.txt'))
                .toBeTruthy();
        });
        expect(screen.getByText('Could not upload the files.'))
            .toBeTruthy();
    });
});

describe('App mascot', () => {
    it('shows no done face after the owner pressed Stop, when the turn ends', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(stopTurn)
            .mockResolvedValue(undefined);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handler exists.
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: true });
        });
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

        act(() => {
            emitEvent.current?.({ type: 'turn', botId: 'bot-1', isRunning: false });
        });

        expect(stopTurn)
            .toHaveBeenCalledWith('bot-1');
        expect(container.querySelector('.is-done'))
            .toBeNull();
        expect(container.querySelector('.cloud-mascot.is-idle'))
            .not.toBeNull();
    });
});

describe('App draft', () => {
    async function renderWithStream(): Promise<{ container: HTMLElement; emit: (event: ChatEvent) => void }> {
        const stream: { onEvent?: (event: ChatEvent) => void } = {};

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                stream.onEvent = onEvent;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(stream.onEvent)
                .toBeDefined();
        });

        return {
            container,
            emit: (event) => {
                act(() => {
                    stream.onEvent?.(event);
                });
            },
        };
    }

    it('joins the deltas of one frame into the draft', async () => {
        const { container, emit } = await renderWithStream();

        emit({ type: 'textDelta', botId: 'bot-1', text: 'Hello ' });
        emit({ type: 'textDelta', botId: 'bot-1', text: 'there' });

        await waitFor(() => {
            expect(container.querySelector('.is-draft')?.textContent
                .trim())
                .toBe('Hello there');
        });
    });

    it('drops deltas still waiting for a frame when the stored message arrives', async () => {
        const { container, emit } = await renderWithStream();
        const stored: ChatMessage = { id: 'r1', botId: 'bot-1', role: 'assistant', createdAt: 1, sequence: 1, body: { kind: 'text', text: 'Stored reply' } };

        emit({ type: 'textDelta', botId: 'bot-1', text: 'Stored' });
        emit({ type: 'message', message: stored });

        await waitFor(() => {
            expect(container.textContent)
                .toContain('Stored reply');
        });
        // Two frames pass, so a delta drawn late would show by now.
        await new Promise((resolve) => {
            window.requestAnimationFrame(() => {
                window.requestAnimationFrame(resolve);
            });
        });

        expect(container.querySelector('.is-draft'))
            .toBeNull();
    });

    it('drops the draft when a reply missed during a dropout shows up in the reload', async () => {
        const stream: { onEvent?: (event: ChatEvent) => void; onOpen?: () => void } = {};
        const reply: ChatMessage = {
            id: 'm1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'text', text: 'Final reply' },
        };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValueOnce([reply]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent, onOpen) => {
                stream.onEvent = onEvent;
                stream.onOpen = onOpen;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handlers exist.
        await waitFor(() => {
            expect(stream.onEvent)
                .toBeDefined();
        });

        act(() => {
            stream.onEvent?.({ type: 'textDelta', botId: 'bot-1', text: 'Partial' });
        });

        // Deltas are drawn on the next animation frame.
        await waitFor(() => {
            expect(container.querySelector('.is-draft'))
                .not.toBeNull();
        });

        act(() => {
            stream.onOpen?.();
        });

        await waitFor(() => {
            expect(container.textContent)
                .toContain('Final reply');
        });
        expect(container.querySelector('.is-draft'))
            .toBeNull();
    });
});

describe('App draft and history', () => {
    const oldReply: ChatMessage = {
        id: 'old',
        botId: 'bot-1',
        role: 'assistant',
        createdAt: 1,
        sequence: 5,
        body: { kind: 'text', text: 'Earlier reply' },
    };

    async function streamDraftThenReload(historyAfterDelta: ChatMessage[]): Promise<HTMLElement> {
        const stream: { onEvent?: (event: ChatEvent) => void; onOpen?: () => void } = {};

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValueOnce(historyAfterDelta);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent, onOpen) => {
                stream.onEvent = onEvent;
                stream.onOpen = onOpen;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        // The subscription starts in an effect after the name shows, so wait until the handlers exist.
        await waitFor(() => {
            expect(stream.onOpen)
                .toBeDefined();
        });

        // Separate acts, so the sequence ref catches up with the stored reply before the draft starts.
        act(() => {
            stream.onEvent?.({ type: 'message', message: oldReply });
        });
        act(() => {
            stream.onEvent?.({ type: 'textDelta', botId: 'bot-1', text: 'prefix ' });
        });

        act(() => {
            stream.onOpen?.();
        });

        await waitFor(() => {
            historyAfterDelta.forEach((message) => {
                if (message.body.kind === 'text') {
                    expect(container.textContent)
                        .toContain(message.body.text);
                }
            });
        });

        return container;
    }

    it('keeps a live draft when the reload only returns replies older than it', async () => {
        const container = await streamDraftThenReload([oldReply]);

        expect(container.querySelector('.is-draft'))
            .not.toBeNull();
        expect(container.textContent)
            .toContain('prefix');
    });

    it('clears the draft when the reload returns a reply stored after it started', async () => {
        const newerReply: ChatMessage = { ...oldReply, id: 'newer', sequence: 6, body: { kind: 'text', text: 'Newer reply' } };
        const container = await streamDraftThenReload([oldReply, newerReply]);

        await waitFor(() => {
            expect(container.textContent)
                .toContain('Newer reply');
        });
        expect(container.querySelector('.is-draft'))
            .toBeNull();
    });
});

function createHistoryMessage(sequence: number, botId = 'bot-1'): ChatMessage {
    return {
        id: `${botId}-history-${String(sequence)}`,
        botId,
        role: 'user',
        createdAt: sequence,
        sequence,
        body: { kind: 'text', text: `${botId} ${String(sequence)}` },
    };
}

function fullPageOf(botId: string): ChatMessage[] {
    return Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(index + 51, botId));
}

function scrollToTop(container: HTMLElement): void {
    const messageList = container.querySelector<HTMLElement>('.message-list');

    if (messageList === null) {
        throw new Error('The message list is missing');
    }

    fireEvent.scroll(messageList, { target: { scrollTop: 0 } });
}

// Lets the pending state updates of the last request settle.
async function settle(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    });
}

// Renders the app with one bot whose first page is the given messages. reconnect runs the
// stream connect again, which reloads the newest page of the selected bot.
async function renderWithFirstPage(firstPage: ChatMessage[]): Promise<{ container: HTMLElement; reconnect: () => void; emitEvent: (event: ChatEvent) => void }> {
    const stream: { onOpen?: () => void; onEvent?: (event: ChatEvent) => void } = {};

    // Reset first, so calls and queued answers from earlier tests do not leak into this one.
    vi.mocked(listMessages)
        .mockReset();
    vi.mocked(listBots)
        .mockResolvedValue([createBot('CloudBot')]);
    vi.mocked(listMessages)
        .mockResolvedValueOnce(firstPage);
    vi.mocked(subscribeToEvents)
        .mockImplementation((_botId, onEvent, onOpen) => {
            stream.onEvent = onEvent;
            stream.onOpen = onOpen;

            return () => {};
        });

    const { container } = render(<App />);

    await waitFor(() => {
        expect(renderedBotName())
            .toBe('CloudBot');
    });

    // The subscription starts in an effect after the bot is shown, so wait for it before connecting.
    await waitFor(() => {
        expect(stream.onOpen)
            .toBeDefined();
    });

    act(() => {
        stream.onOpen?.();
    });

    await waitFor(() => {
        expect(container.textContent)
            .toContain(firstPage[0]?.body.kind === 'text' ? firstPage[0].body.text : '');
    });

    return {
        container,
        reconnect: () => {
            act(() => {
                stream.onOpen?.();
            });
        },
        emitEvent: (event: ChatEvent) => {
            act(() => {
                stream.onEvent?.(event);
            });
        },
    };
}

describe('App older messages', () => {
    it('asks for the page before the oldest message when the list is scrolled to the top', async () => {
        const { container } = await renderWithFirstPage(fullPageOf('bot-1'));

        vi.mocked(listMessages)
            .mockResolvedValueOnce([]);

        scrollToTop(container);

        await waitFor(() => {
            expect(listMessages)
                .toHaveBeenLastCalledWith('bot-1', { beforeSequence: 51, limit: 50 });
        });
    });

    it('does not ask for older messages when the newest page was not full', async () => {
        const shortPage = [createHistoryMessage(1), createHistoryMessage(2), createHistoryMessage(3)];
        const { container } = await renderWithFirstPage(shortPage);

        scrollToTop(container);

        expect(listMessages)
            .toHaveBeenCalledTimes(1);
    });

    it('replaces the held messages when a reconnect finds messages after a gap', async () => {
        const { container, reconnect } = await renderWithFirstPage([createHistoryMessage(1), createHistoryMessage(2)]);

        vi.mocked(listMessages)
            .mockResolvedValueOnce([createHistoryMessage(200), createHistoryMessage(201)]);

        reconnect();

        // Waits for the committed list, since React renders state set by a promise on its own tick.
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 200');
        });
        expect(container.textContent)
            .not.toContain('bot-1 1');
    });

    it('keeps a local message inside the page range on reconnect, such as the setup echo', async () => {
        const { container, reconnect, emitEvent } = await renderWithFirstPage([createHistoryMessage(1), createHistoryMessage(2)]);
        const localEcho: ChatMessage = { ...createHistoryMessage(1), id: 'local-echo', sequence: 1.5, body: { kind: 'text', text: 'typed during setup' } };

        emitEvent({ type: 'message', message: localEcho });
        vi.mocked(listMessages)
            .mockResolvedValueOnce([createHistoryMessage(1), createHistoryMessage(2), createHistoryMessage(3)]);

        reconnect();

        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 3');
        });
        expect(container.textContent)
            .toContain('typed during setup');
    });

    it('replaces the held messages with the newest page on reconnect', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));

        vi.mocked(listMessages)
            .mockResolvedValueOnce(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(60 + index)));

        reconnect();

        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 109');
        });
        expect(container.textContent)
            .toContain('bot-1 60');
        expect(container.textContent)
            .not.toContain('bot-1 51');
    });

    it('keeps a message held from the stream that is newer than the reconnect page', async () => {
        const heldPage = Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(index + 1));
        const { container, reconnect, emitEvent } = await renderWithFirstPage(heldPage);

        // The stream drops after 50 and this browser then gets message 151 over HTTP, so 151 is held before the reconnect.
        emitEvent({ type: 'message', message: createHistoryMessage(151) });
        vi.mocked(listMessages)
            .mockResolvedValueOnce(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(102 + index)));

        reconnect();

        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 102');
        });
        expect(container.textContent)
            .toContain('bot-1 151');
        expect(container.textContent)
            .not.toContain('bot-1 50');
    });

    it('still replaces the list when a stream message arrives before the reload answers', async () => {
        const { container, reconnect, emitEvent } = await renderWithFirstPage(fullPageOf('bot-1'));
        const reloadAnswer: { release?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                reloadAnswer.release = resolve;
            }));

        reconnect();
        emitEvent({ type: 'message', message: createHistoryMessage(201) });

        act(() => {
            reloadAnswer.release?.(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(151 + index)));
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 151');
        });
        expect(container.textContent)
            .toContain('bot-1 201');
        expect(container.textContent)
            .not.toContain('bot-1 51');
    });

    it('drops a reload answer that arrives after a newer reload', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));
        const staleAnswer: { release?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                staleAnswer.release = resolve;
            }));

        reconnect();
        vi.mocked(listMessages)
            .mockResolvedValueOnce(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(151 + index)));
        reconnect();
        await settle();

        act(() => {
            staleAnswer.release?.(fullPageOf('bot-1'));
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 151');
        });
        expect(container.textContent)
            .not.toContain('bot-1 51');
    });

    it('drops an older page that arrives after a reload replaced the list', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));
        const olderAnswer: { release?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                olderAnswer.release = resolve;
            }));

        scrollToTop(container);
        vi.mocked(listMessages)
            .mockResolvedValueOnce(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(151 + index)));
        reconnect();
        await settle();

        act(() => {
            olderAnswer.release?.(Array.from({ length: 10 }, (_unused, index) => createHistoryMessage(41 + index)));
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 151');
        });
        expect(container.textContent)
            .not.toContain('bot-1 41');
    });

    it('drops an older page requested before a reload replaced the list', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));
        const reloadAnswer: { release?: (messages: ChatMessage[]) => void } = {};
        const olderAnswer: { release?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                reloadAnswer.release = resolve;
            }));
        reconnect();

        // The older page is requested after the reload started, so it passes the generation check.
        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                olderAnswer.release = resolve;
            }));
        scrollToTop(container);

        act(() => {
            reloadAnswer.release?.(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(151 + index)));
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 151');
        });

        act(() => {
            olderAnswer.release?.(Array.from({ length: 10 }, (_unused, index) => createHistoryMessage(41 + index)));
        });
        await settle();

        expect(container.textContent)
            .not.toContain('bot-1 41');
    });

    it('keeps the reload result when a stale older page resolves in the same tick', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));
        const reloadAnswer: { release?: (messages: ChatMessage[]) => void } = {};
        const olderAnswer: { release?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                reloadAnswer.release = resolve;
            }));
        reconnect();

        vi.mocked(listMessages)
            .mockReturnValueOnce(new Promise<ChatMessage[]>((resolve) => {
                olderAnswer.release = resolve;
            }));
        scrollToTop(container);

        // Both answers arrive before React commits anything. The short older page must not win.
        act(() => {
            reloadAnswer.release?.(Array.from({ length: MESSAGE_PAGE_SIZE }, (_unused, index) => createHistoryMessage(151 + index)));
            olderAnswer.release?.(Array.from({ length: 10 }, (_unused, index) => createHistoryMessage(41 + index)));
        });

        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 151');
        });
        expect(container.textContent)
            .not.toContain('bot-1 41');
        expect(container.textContent)
            .not.toContain('bot-1 51');

        // The list still has more above it, so scrolling to the top asks for the page before 151.
        scrollToTop(container);

        expect(listMessages)
            .toHaveBeenLastCalledWith('bot-1', { beforeSequence: 151, limit: 50 });
    });

    it('clears the older-load error when the reader switches bot', async () => {
        const stream: { onOpen?: () => void } = {};

        vi.mocked(listMessages)
            .mockReset();
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot', 'bot-1'), createBot('Ana', 'bot-2')]);
        vi.mocked(listMessages)
            .mockImplementation((botId, page) => {
                if (page?.beforeSequence === undefined) {
                    return Promise.resolve(fullPageOf(botId));
                }

                if (botId === 'bot-1') {
                    return Promise.reject(new Error('offline'));
                }

                return Promise.resolve([]);
            });
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, _onEvent, onOpen) => {
                stream.onOpen = onOpen;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        await waitFor(() => {
            expect(stream.onOpen)
                .toBeDefined();
        });

        act(() => {
            stream.onOpen?.();
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 51');
        });

        scrollToTop(container);
        await waitFor(() => {
            expect(container.textContent)
                .toContain('Could not load older messages.');
        });

        fireEvent.click(screen.getByText('Ana', { selector: '.bot-name' }));

        await waitFor(() => {
            expect(container.textContent)
                .not.toContain('Could not load older messages.');
        });
    });

    it('sets hasMore from the newest page on reconnect, even after the beginning was reached', async () => {
        const { container, reconnect } = await renderWithFirstPage(fullPageOf('bot-1'));

        vi.mocked(listMessages)
            .mockResolvedValueOnce([createHistoryMessage(48), createHistoryMessage(49), createHistoryMessage(50)]);

        scrollToTop(container);
        await settle();

        vi.mocked(listMessages)
            .mockResolvedValueOnce(fullPageOf('bot-1'));

        reconnect();
        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Load older messages' }))
                .toBeTruthy();
        });
        scrollToTop(container);

        // The full newest page means more may exist above it, so the page before 51 is asked for.
        expect(listMessages)
            .toHaveBeenLastCalledWith('bot-1', { beforeSequence: 51, limit: 50 });
    });

    it('retries a failed older load on the next scroll to the top, without a request loop', async () => {
        const { container } = await renderWithFirstPage(fullPageOf('bot-1'));

        vi.mocked(listMessages)
            .mockRejectedValueOnce(new Error('offline'));

        scrollToTop(container);
        await settle();

        expect(container.textContent)
            .toContain('Could not load older messages.');
        expect(listMessages)
            .toHaveBeenCalledTimes(2);

        vi.mocked(listMessages)
            .mockResolvedValueOnce([]);

        scrollToTop(container);
        await settle();

        expect(listMessages)
            .toHaveBeenCalledTimes(3);
    });

    it('pages one bot without waiting on a load for another, and keeps each bot paging state', async () => {
        const stream: { onOpen?: () => void } = {};
        const pending: { releaseBotOne?: (messages: ChatMessage[]) => void } = {};

        vi.mocked(listMessages)
            .mockReset();
        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot', 'bot-1'), createBot('Ana', 'bot-2')]);
        vi.mocked(listMessages)
            .mockImplementation((botId, page) => {
                if (page?.beforeSequence === undefined) {
                    return Promise.resolve(fullPageOf(botId));
                }

                if (botId === 'bot-1') {
                    return new Promise<ChatMessage[]>((resolve) => {
                        pending.releaseBotOne = resolve;
                    });
                }

                return Promise.resolve([]);
            });
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, _onEvent, onOpen) => {
                stream.onOpen = onOpen;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        await waitFor(() => {
            expect(stream.onOpen)
                .toBeDefined();
        });

        act(() => {
            stream.onOpen?.();
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-1 51');
        });

        scrollToTop(container);

        fireEvent.click(screen.getByText('Ana', { selector: '.bot-name' }));
        act(() => {
            stream.onOpen?.();
        });
        await waitFor(() => {
            expect(container.textContent)
                .toContain('bot-2 51');
        });

        scrollToTop(container);
        await waitFor(() => {
            expect(listMessages)
                .toHaveBeenLastCalledWith('bot-2', { beforeSequence: 51, limit: 50 });
        });

        // The late page for bot-1 arrives while another bot is selected.
        act(() => {
            pending.releaseBotOne?.([createHistoryMessage(50, 'bot-1')]);
        });
        await settle();

        fireEvent.click(screen.getByText('CloudBot', { selector: '.bot-name' }));
        await settle();
        scrollToTop(container);

        // Bot-1 is not stuck loading, and its oldest message is still 51, so the same page is asked again.
        expect(listMessages)
            .toHaveBeenLastCalledWith('bot-1', { beforeSequence: 51, limit: 50 });
    });
});

describe('App setup reminder', () => {
    it('shows local input and the assistant reminder and clears Stop without a turn event', async () => {
        const reminder: ChatMessage = {
            id: 'reminder', botId: 'bot-1', role: 'assistant', sequence: 2, createdAt: 1,
            body: { kind: 'text', text: 'Finish connecting an AI provider above to start chatting.' },
        };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation(() => () => {});
        vi.mocked(sendMessage)
            .mockResolvedValue(reminder);

        const view = render(<App />);

        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });

        const composer = view.getByRole('textbox');

        fireEvent.change(composer, { target: { value: 'private input' } });
        fireEvent.click(view.getByRole('button', { name: 'Send' }));
        await waitFor(() => {
            expect(view.queryByRole('button', { name: 'Stop' }))
                .toBeNull();
            expect(view.container.querySelector('.message-user')?.textContent.trim())
                .toBe('private input');
            expect(view.container.querySelector('.message-assistant')?.textContent)
                .toContain('Finish connecting an AI provider above');
        });
        cleanup();
        render(<App />);
        await waitFor(() => {
            expect(renderedBotName())
                .toBe('CloudBot');
        });
        expect(document.body.textContent).not.toContain('private input');
    });

    it('shows a webhook URL the bot made once, and Hide removes it', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('Ana')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'webhookUrl', botId: 'bot-1', name: 'form tool', url: 'https://bot.example.test/hooks/secret-token' });
        });

        expect(await screen.findByLabelText('Webhook URL'))
            .toHaveProperty('value', 'https://bot.example.test/hooks/secret-token');

        fireEvent.click(screen.getByRole('button', { name: 'Hide URL' }));

        expect(screen.queryByLabelText('Webhook URL'))
            .toBeNull();
    });

    it('shows one-time sign-in details from a person credentials event and Hide clears them', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('Ana')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'personCredentials', botId: 'bot-1', name: 'maria', address: 'https://maria.example.test', password: 'one-time-secret' });
        });

        expect(await screen.findByLabelText('Sign-in address'))
            .toHaveProperty('value', 'https://maria.example.test');
        expect(screen.getByLabelText('Sign-in password'))
            .toHaveProperty('value', 'one-time-secret');
        expect(screen.getByText('Save this now. It is not shown again.'))
            .toBeDefined();

        fireEvent.click(screen.getByRole('button', { name: 'Hide details' }));

        expect(screen.queryByLabelText('Sign-in password'))
            .toBeNull();
    });

    it('keeps the first webhook URL when the bot makes a second one', async () => {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('Ana')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        render(<App />);
        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        act(() => {
            emitEvent.current?.({ type: 'webhookUrl', botId: 'bot-1', name: 'stripe', url: 'https://bot.example.test/hooks/first' });
            emitEvent.current?.({ type: 'webhookUrl', botId: 'bot-1', name: 'github', url: 'https://bot.example.test/hooks/second' });
        });

        await waitFor(() => {
            expect(screen.getAllByLabelText('Webhook URL'))
                .toHaveLength(2);
        });

        const [firstHide] = screen.getAllByRole('button', { name: 'Hide URL' });

        fireEvent.click(firstHide as HTMLElement);

        const remaining = screen.getAllByLabelText('Webhook URL');

        expect(remaining)
            .toHaveLength(1);
        expect(remaining[0])
            .toHaveProperty('value', 'https://bot.example.test/hooks/second');
    });
});

describe('App thinking bubble', () => {
    // Renders the app with a stream the test drives, and waits until the bot's events are subscribed.
    async function renderApp(): Promise<{ container: HTMLElement; emit: (event: ChatEvent) => void }> {
        const emitEvent: { current: ((event: ChatEvent) => void) | undefined } = { current: undefined };

        vi.mocked(listBots)
            .mockResolvedValue([createBot('CloudBot')]);
        vi.mocked(listMessages)
            .mockResolvedValue([]);
        vi.mocked(subscribeToEvents)
            .mockImplementation((_botId, onEvent) => {
                emitEvent.current = onEvent;

                return () => {};
            });

        const { container } = render(<App />);

        await waitFor(() => {
            expect(emitEvent.current)
                .toBeDefined();
        });

        return {
            container,
            emit: (event: ChatEvent) => {
                act(() => {
                    emitEvent.current?.(event);
                });
            },
        };
    }

    it('names the tool in the bubble and keeps its stored row out of the chat', async () => {
        const toolRow: ChatMessage = {
            id: 't1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'toolActivity', toolName: 'WebFetch', status: 'done', summary: 'Fetched example.com' },
        };
        const { container, emit } = await renderApp();

        emit({ type: 'turn', botId: 'bot-1', isRunning: true });
        emit({ type: 'toolStarted', botId: 'bot-1', toolName: 'WebFetch' });

        await waitFor(() => {
            expect(container.querySelector('.thinking-line')?.textContent)
                .toBe('Reading a web page');
        });

        emit({ type: 'message', message: toolRow });

        expect(container.querySelector('[data-message-id="t1"]'))
            .toBeNull();
    });

    it('hides a failed tool row without leaving an empty message wrapper', async () => {
        const toolRow: ChatMessage = {
            id: 't1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'toolActivity', toolName: 'read_file', status: 'error', summary: 'tool call denied by pre-tool hook: internal details' },
        };
        const { container, emit } = await renderApp();

        emit({ type: 'message', message: toolRow });

        expect(container.querySelector('.message-list')?.childElementCount)
            .toBe(0);
        expect(container.querySelector('[data-message-id="t1"]'))
            .toBeNull();
        expect(container.textContent)
            .not.toContain('internal details');
    });

    it('does not mark a failed tool row as an unread reply', async () => {
        const tabIcon = document.createElement('link');

        tabIcon.setAttribute('data-tab-icon', '');
        tabIcon.setAttribute('href', '/favicon.svg');
        document.head.append(tabIcon);
        vi.spyOn(document, 'hidden', 'get')
            .mockReturnValue(true);

        const failedToolRow: ChatMessage = {
            id: 't1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'toolActivity', toolName: 'read_file', status: 'error', summary: 'internal details' },
        };
        const { emit } = await renderApp();

        emit({ type: 'message', message: failedToolRow });

        expect(tabIcon.getAttribute('href'))
            .toBe('/favicon.svg');
    });

    it('stops naming a tool once its row is stored, until the next tool starts', async () => {
        const toolRow: ChatMessage = {
            id: 't1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'toolActivity', toolName: 'WebFetch', status: 'done', summary: 'Fetched example.com' },
        };
        const { container, emit } = await renderApp();

        emit({ type: 'turn', botId: 'bot-1', isRunning: true });
        emit({ type: 'toolStarted', botId: 'bot-1', toolName: 'WebFetch' });

        await waitFor(() => {
            expect(container.querySelector('.thinking-line')?.textContent)
                .toBe('Reading a web page');
        });

        emit({ type: 'message', message: toolRow });

        expect(container.querySelector('.thinking-line')?.textContent)
            .toBe('Thinking');
    });

    it('hides the bubble once the reply starts streaming', async () => {
        const { container, emit } = await renderApp();

        emit({ type: 'turn', botId: 'bot-1', isRunning: true });

        await waitFor(() => {
            expect(container.querySelector('.message.is-thinking'))
                .not.toBeNull();
        });

        emit({ type: 'textDelta', botId: 'bot-1', text: 'Hel' });

        // Deltas are batched into one frame, so the draft, and with it the hidden bubble, lands on the next frame.
        await waitFor(() => {
            expect(container.querySelector('.message.is-thinking'))
                .toBeNull();
        });
    });

    it('shows nothing in the gap between the final text and the end of the turn', async () => {
        const finalReply: ChatMessage = {
            id: 'a1',
            botId: 'bot-1',
            role: 'assistant',
            createdAt: 1,
            sequence: 1,
            body: { kind: 'text', text: 'Done.' },
        };
        const { container, emit } = await renderApp();

        emit({ type: 'turn', botId: 'bot-1', isRunning: true });
        emit({ type: 'message', message: finalReply });
        emit({ type: 'turn', botId: 'bot-1', isRunning: false });

        await new Promise((resolve) => {
            setTimeout(resolve, 400);
        });

        expect(container.querySelector('.message.is-thinking'))
            .toBeNull();
    });
});
