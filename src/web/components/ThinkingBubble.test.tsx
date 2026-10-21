// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINE_INTERVAL_MS, THINKING_LINES } from '../thinkingBubble.ts';
import { ThinkingBubble } from './ThinkingBubble.tsx';

describe('ThinkingBubble', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('shows the first thinking line and a status role', () => {
        render(<ThinkingBubble color="blue" shape="puff" />);

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[0]);
    });

    it('changes the thinking line every interval without a tool', () => {
        render(<ThinkingBubble color="blue" shape="puff" />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS);
        });

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[1]);
    });

    it('names the active tool in plain words and does not cycle', () => {
        render(<ThinkingBubble color="blue" shape="puff" activeToolName="WebSearch" />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS * 2);
        });

        expect(screen.getByRole('status').textContent)
            .toContain('Searching the web');
    });

    it('renders three dots that are hidden from assistive tech', () => {
        const { container } = render(<ThinkingBubble color="blue" shape="puff" />);
        const dots = container.querySelectorAll('.thinking-dots i');

        expect(dots.length)
            .toBe(3);
        const dotsRow = container.querySelector('.thinking-dots');

        expect(dotsRow?.getAttribute('aria-hidden'))
            .toBe('true');
    });

    it('marks the bubble and the mascot as the thinking state', () => {
        const { container } = render(<ThinkingBubble color="blue" shape="puff" />);

        expect(container.querySelector('.message.is-thinking.has-mascot'))
            .not.toBeNull();
    });

    it('keeps the changing line silent for screen readers and labels the bubble', () => {
        const { container } = render(<ThinkingBubble color="blue" shape="puff" />);

        const liveLine = container.querySelector('.thinking-line');

        expect(liveLine?.getAttribute('aria-live'))
            .toBe('off');
        const bubbleStatus = screen.getByRole('status');

        expect(bubbleStatus.getAttribute('aria-label'))
            .toBe('Bot is working');
    });
});
