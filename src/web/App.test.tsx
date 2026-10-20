// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary, ChatEvent, ChatMessage } from '../shared/chatTypes.ts';
import { App } from './App.tsx';
import { listBots, listMessages, subscribeToEvents } from './apiClient.ts';

vi.mock('./apiClient.ts', () => ({
    listBots: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    stopTurn: vi.fn(),
    submitChoice: vi.fn(),
    submitCode: vi.fn(),
    submitSecret: vi.fn(),
    subscribeToEvents: vi.fn(),
    uploadAttachments: vi.fn(),
}));

function createBot(name: string): BotSummary {
    return {
        id: 'bot-1',
        name,
        title: 'Coworker',
        avatarColor: '#336699',
        lastMessagePreview: '',
        hasUnread: false,
    };
}

function renderedBotName(): string | null | undefined {
    return document.querySelector('.bot-name')?.textContent;
}

afterEach(() => {
    cleanup();
});

describe('App bot list', () => {
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
});

describe('App draft', () => {
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

        act(() => {
            stream.onEvent?.({ type: 'textDelta', botId: 'bot-1', text: 'Partial' });
        });

        expect(container.querySelector('.is-draft'))
            .not.toBeNull();

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

        // Separate acts, so the sequence ref catches up with the stored reply before the draft starts.
        act(() => {
            stream.onEvent?.({ type: 'message', message: oldReply });
        });
        act(() => {
            stream.onEvent?.({ type: 'textDelta', botId: 'bot-1', text: 'prefix ' });
        });

        await act(async () => {
            stream.onOpen?.();
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
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

        expect(container.querySelector('.is-draft'))
            .toBeNull();
        expect(container.textContent)
            .toContain('Newer reply');
    });
});
