// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type * as ApiClient from '../apiClient.ts';
import { getBotMemory, RequestFailedError, saveBotMemory } from '../apiClient.ts';
import { MemoryPanel } from './MemoryPanel.tsx';

vi.mock('../apiClient.ts', async (importOriginal) => {
    const original = await importOriginal<typeof ApiClient>();

    return { ...original, getBotMemory: vi.fn(), saveBotMemory: vi.fn() };
});

const BOT: BotSummary = { id: 'bot-1', name: 'Ana', title: '', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'dots', mascotWeather: 'auto', mascotBolt: 'down', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };
const REFUSAL = 'The bot changed its memory.';

function forget(lineText: string): void {
    fireEvent.click(screen.getByRole('button', { name: `Forget: ${lineText}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
}

describe('MemoryPanel', () => {
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    it('removes one line and saves against the text it read', async () => {
        vi.mocked(getBotMemory)
            .mockResolvedValue({ text: '- Tea\n- Rex\n', isCut: false });
        vi.mocked(saveBotMemory)
            .mockResolvedValue(undefined);

        render(<MemoryPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Rex');
        forget('Tea');

        await waitFor(() => {
            expect(screen.queryByText('Tea'))
                .toBeNull();
        });
        expect(saveBotMemory)
            .toHaveBeenCalledWith('bot-1', '- Rex\n', '- Tea\n- Rex\n');
    });

    it('shows the new text when the bot changed the file first', async () => {
        vi.mocked(getBotMemory)
            .mockResolvedValueOnce({ text: '- Tea\n', isCut: false })
            .mockResolvedValueOnce({ text: '- Tea\n- New note\n', isCut: false });
        vi.mocked(saveBotMemory)
            .mockRejectedValue(new RequestFailedError('/memory', 409, REFUSAL));

        render(<MemoryPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Tea');
        forget('Tea');

        await screen.findByText('New note');
        expect(screen.getByRole('alert').textContent)
            .toBe(REFUSAL);
    });

    it('offers no changes on a memory past the cap', async () => {
        vi.mocked(getBotMemory)
            .mockResolvedValue({ text: 'Tea', isCut: true });

        render(<MemoryPanel bot={BOT} onClose={vi.fn()} />);
        await screen.findByText('Tea');

        expect(screen.queryByRole('button', { name: 'Edit memory' }))
            .toBeNull();
        expect(screen.queryByRole('button', { name: 'Forget: Tea' }))
            .toBeNull();
    });
});
