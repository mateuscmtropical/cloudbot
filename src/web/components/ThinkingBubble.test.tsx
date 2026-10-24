// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINE_INTERVAL_MS, THINKING_LINES } from '../thinkingBubble.ts';
import { ThinkingBubble } from './ThinkingBubble.tsx';

const MASCOT = { mascotColor: 'blue', mascotShape: 'puff' } as const;

describe('ThinkingBubble', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('shows the first thinking line and a status role', () => {
        render(<ThinkingBubble {...MASCOT} />);

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[0]);
    });

    it('changes the thinking line every interval without a tool', () => {
        render(<ThinkingBubble {...MASCOT} />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS);
        });

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[1]);
    });

    it('names the active tool in plain words and does not cycle', () => {
        render(<ThinkingBubble {...MASCOT} activeToolName="WebSearch" />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS * 2);
        });

        expect(screen.getByRole('status').textContent)
            .toContain('Searching the web');
    });

    it('shows the bot mascot with eyes that look around, outside a bubble', () => {
        const { container } = render(<ThinkingBubble {...MASCOT} />);

        expect(container.querySelector('.message.is-thinking .thinking-status .cloud-mascot')
            ?.getAttribute('data-state'))
            .toBe('working');
        expect(container.querySelector('.message.is-thinking .bubble'))
            .toBeNull();
    });
    it('keeps the changing line silent for screen readers and labels the bubble', () => {
        const { container } = render(<ThinkingBubble {...MASCOT} />);

        const liveLine = container.querySelector('.thinking-line');

        expect(liveLine?.getAttribute('aria-live'))
            .toBe('off');
        const bubbleStatus = screen.getByRole('status');

        expect(bubbleStatus.getAttribute('aria-label'))
            .toBe('Bot is working');
    });
});
