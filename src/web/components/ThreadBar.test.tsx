// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadSummary } from '../../shared/chatTypes.ts';
import { createThread, deleteThread, listThreads } from '../apiClient.ts';
import { ThreadBar } from './ThreadBar.tsx';

vi.mock('../apiClient.ts', () => ({
    createThread: vi.fn(),
    deleteThread: vi.fn(),
    listThreads: vi.fn(),
    RequestFailedError: class RequestFailedError extends Error {
        serverMessage: string | undefined;
    },
}));

const OWN_CHAT: ThreadSummary = { id: 'bot-1', name: 'Ana', isDefault: true, isRunning: false };
const SIDE_CHAT: ThreadSummary = { id: 'thread-1', name: 'Trip plan', isDefault: false, isRunning: true };

describe('ThreadBar', () => {
    beforeEach(() => {
        vi.mocked(listThreads)
            .mockResolvedValue([OWN_CHAT, SIDE_CHAT]);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('shows the own chat as Main and the other chats by name, and opens one on tap', async () => {
        const onSelect = vi.fn();

        render(<ThreadBar botId="bot-1" activeId="bot-1" refreshKey={0} unreadIds={new Set()} onSelect={onSelect} />);

        const sideChip = await screen.findByRole('tab', { name: 'Trip plan' });

        expect(screen.getByRole('tab', { name: 'Main' })
            .getAttribute('aria-selected'))
            .toBe('true');
        expect(sideChip.getAttribute('data-running'))
            .toBe('true');

        fireEvent.click(sideChip);

        expect(onSelect)
            .toHaveBeenCalledWith('thread-1');
    });

    it('starts a new chat and opens it', async () => {
        const onSelect = vi.fn();

        vi.mocked(createThread)
            .mockResolvedValue({ id: 'thread-2', name: 'New chat', isDefault: false, isRunning: false });
        render(<ThreadBar botId="bot-1" activeId="bot-1" refreshKey={0} unreadIds={new Set()} onSelect={onSelect} />);
        await screen.findByRole('tab', { name: 'Trip plan' });
        fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

        await waitFor(() => {
            expect(onSelect)
                .toHaveBeenCalledWith('thread-2');
        });
    });

    it('deletes the open side chat after a confirmation and goes back to the own chat', async () => {
        const onSelect = vi.fn();

        vi.mocked(deleteThread)
            .mockResolvedValue(undefined);
        render(<ThreadBar botId="bot-1" activeId="thread-1" refreshKey={0} unreadIds={new Set()} onSelect={onSelect} />);
        await screen.findByRole('tab', { name: 'Trip plan' });
        fireEvent.click(screen.getByRole('button', { name: 'Delete this chat' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

        await waitFor(() => {
            expect(deleteThread)
                .toHaveBeenCalledWith('bot-1', 'thread-1');
            expect(onSelect)
                .toHaveBeenCalledWith('bot-1');
        });
    });

    it('marks only the chats with an unread reply', async () => {
        render(<ThreadBar botId="bot-1" activeId="bot-1" refreshKey={0} unreadIds={new Set(['thread-1'])} onSelect={vi.fn()} />);

        const sideChip = await screen.findByRole('tab', { name: 'Trip plan' });

        expect(sideChip.getAttribute('data-unread'))
            .toBe('true');
        expect(screen.getByRole('tab', { name: 'Main' })
            .getAttribute('data-unread'))
            .toBeNull();
    });

    it('offers no delete button on the own chat', async () => {
        render(<ThreadBar botId="bot-1" activeId="bot-1" refreshKey={0} unreadIds={new Set()} onSelect={vi.fn()} />);
        await screen.findByRole('tab', { name: 'Trip plan' });

        expect(screen.queryByRole('button', { name: 'Delete this chat' }))
            .toBeNull();
    });
});
