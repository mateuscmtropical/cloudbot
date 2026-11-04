// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BotSummary } from '../../shared/chatTypes.ts';
import type { MessageSearchHit } from '../../shared/searchTypes.ts';
import { searchMessages } from '../apiClient.ts';
import { MessageSearchResults } from './MessageSearchResults.tsx';

vi.mock('../apiClient.ts', () => ({ searchMessages: vi.fn() }));

const BOT: BotSummary = { id: 'bot-1', name: 'Ana', title: '', mascotColor: 'blue', mascotShape: 'puff', mascotEyes: 'dots', lastMessagePreview: '', hasUnread: false, lastMessageSequence: 0 };
const HIT: MessageSearchHit = { botId: 'bot-1', messageId: 'm1', sequence: 1, createdAt: 1, snippet: 'the \u0002<b>tea\u0003 list' };

describe('MessageSearchResults', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('marks the match as text and opens the hit', async () => {
        vi.mocked(searchMessages)
            .mockResolvedValue([HIT]);

        const onOpenHit = vi.fn();

        render(<MessageSearchResults query=" tea " bots={[BOT]} onOpenHit={onOpenHit} />);

        const marked = await screen.findByText('<b>tea');

        expect(marked.tagName)
            .toBe('MARK');
        expect(searchMessages)
            .toHaveBeenCalledWith('tea');

        fireEvent.click(marked);

        expect(onOpenHit)
            .toHaveBeenCalledWith(HIT);
    });

    it('does not ask the server for one letter', () => {
        render(<MessageSearchResults query="t" bots={[BOT]} onOpenHit={vi.fn()} />);

        expect(searchMessages)
            .not.toHaveBeenCalled();
    });
});
