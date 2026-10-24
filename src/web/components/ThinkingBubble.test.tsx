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
        render(<ThinkingBubble />);

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[0]);
    });

    it('changes the thinking line every interval without a tool', () => {
        render(<ThinkingBubble />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS);
        });

        expect(screen.getByRole('status').textContent)
            .toContain(THINKING_LINES[1]);
    });

    it('names the active tool in plain words and does not cycle', () => {
        render(<ThinkingBubble activeToolName="WebSearch" />);

        act(() => {
            vi.advanceTimersByTime(LINE_INTERVAL_MS * 2);
        });

        expect(screen.getByRole('status').textContent)
            .toContain('Searching the web');
    });

    it('renders three dots that are hidden from assistive tech', () => {
        const { container } = render(<ThinkingBubble />);
        const dots = container.querySelectorAll('.thinking-dots i');

        expect(dots.length)
            .toBe(3);
        const dotsRow = container.querySelector('.thinking-dots');

        expect(dotsRow?.getAttribute('aria-hidden'))
            .toBe('true');
    });

    it('keeps the thinking bubble in the assistant message flow without an avatar column', () => {
        const { container } = render(<ThinkingBubble />);

        expect(container.querySelector('.message.is-thinking'))
            .not.toBeNull();
        expect(container.querySelector('.message.is-thinking .cloud-mascot'))
            .toBeNull();
    });

    it('keeps the changing line silent for screen readers and labels the bubble', () => {
        const { container } = render(<ThinkingBubble />);

        const liveLine = container.querySelector('.thinking-line');

        expect(liveLine?.getAttribute('aria-live'))
            .toBe('off');
        const bubbleStatus = screen.getByRole('status');

        expect(bubbleStatus.getAttribute('aria-label'))
            .toBe('Bot is working');
    });
});
