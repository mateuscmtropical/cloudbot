// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readSwipe, useSwipeMenu } from './useSwipeMenu.ts';

interface FakeTouch {
    clientX: number;
    clientY: number;
}

function touchEvent(type: 'touchstart' | 'touchend', clientX: number): Event {
    const event = new Event(type, { bubbles: true });
    const point: FakeTouch = { clientX, clientY: 300 };

    Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [point] : [] });
    Object.defineProperty(event, 'changedTouches', { value: [point] });

    return event;
}

function swipeRightOn(element: Element): void {
    const start = touchEvent('touchstart', 20);
    const end = touchEvent('touchend', 200);

    element.dispatchEvent(start);
    element.dispatchEvent(end);
}

describe('readSwipe', () => {
    it('reads a long horizontal drag to the right and to the left', () => {
        expect(readSwipe({ x: 20, y: 300 }, { x: 160, y: 310 }))
            .toBe('right');
        expect(readSwipe({ x: 200, y: 300 }, { x: 60, y: 290 }))
            .toBe('left');
    });

    it('ignores a short drag', () => {
        expect(readSwipe({ x: 20, y: 300 }, { x: 60, y: 300 }))
            .toBeUndefined();
    });

    it('ignores a drag that is mostly vertical or diagonal', () => {
        expect(readSwipe({ x: 20, y: 100 }, { x: 100, y: 400 }))
            .toBeUndefined();
        expect(readSwipe({ x: 20, y: 100 }, { x: 120, y: 200 }))
            .toBeUndefined();
    });
});

describe('useSwipeMenu', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    it('opens the menu on a swipe, but leaves a drag on the bot screen to the screen', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        const setIsOpen = vi.fn();
        const panel = document.createElement('section');
        const message = document.createElement('p');

        panel.className = 'desktop-panel';
        document.body.append(panel, message);
        renderHook(() => {
            useSwipeMenu(false, setIsOpen);
        });

        swipeRightOn(panel);

        expect(setIsOpen)
            .not.toHaveBeenCalled();

        swipeRightOn(message);

        expect(setIsOpen)
            .toHaveBeenCalledWith(true);
    });
});
