// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { readSwipe, useSwipeMenu } from './useSwipeMenu.ts';
import type { SwipePanels } from './useSwipeMenu.ts';

interface FakeTouch {
    clientX: number;
    clientY: number;
}

interface SwipePanelSpies {
    setIsListOpen: Mock;
    setIsDetailsOpen: Mock;
}

function touchEvent(type: 'touchstart' | 'touchend', clientX: number): Event {
    const event = new Event(type, { bubbles: true });
    const point: FakeTouch = { clientX, clientY: 300 };

    Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [point] : [] });
    Object.defineProperty(event, 'changedTouches', { value: [point] });

    return event;
}

function swipeOn(element: Element, startX: number, endX: number): void {
    const start = touchEvent('touchstart', startX);
    const end = touchEvent('touchend', endX);

    element.dispatchEvent(start);
    element.dispatchEvent(end);
}

function swipeRightOn(element: Element): void {
    swipeOn(element, 20, 200);
}

function swipeLeftOn(element: Element): void {
    swipeOn(element, 200, 20);
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
        cleanup();
        vi.unstubAllGlobals();
        document.body.replaceChildren();
    });

    function renderPanels(state: Partial<SwipePanels> = {}): SwipePanelSpies {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        const setIsListOpen = vi.fn();
        const setIsDetailsOpen = vi.fn();

        renderHook(() => {
            useSwipeMenu({ isListOpen: false, setIsListOpen, isDetailsOpen: false, setIsDetailsOpen, canOpenDetails: true, ...state });
        });

        return { setIsListOpen, setIsDetailsOpen };
    }

    function addParagraph(): HTMLElement {
        const paragraph = document.createElement('p');

        document.body.append(paragraph);

        return paragraph;
    }

    it('opens the list on a swipe to the right and the details on a swipe to the left', () => {
        const spies = renderPanels();
        const message = addParagraph();

        swipeRightOn(message);

        expect(spies.setIsListOpen)
            .toHaveBeenCalledWith(true);
        expect(spies.setIsDetailsOpen)
            .not.toHaveBeenCalled();

        swipeLeftOn(message);

        expect(spies.setIsDetailsOpen)
            .toHaveBeenCalledWith(true);
    });

    it('closes the open panel with the opposite swipe, and opens nothing with the same one', () => {
        const message = addParagraph();
        const withList = renderPanels({ isListOpen: true });

        swipeRightOn(message);

        expect(withList.setIsListOpen)
            .not.toHaveBeenCalled();

        swipeLeftOn(message);

        expect(withList.setIsListOpen)
            .toHaveBeenCalledWith(false);
        expect(withList.setIsDetailsOpen)
            .not.toHaveBeenCalled();

        cleanup();

        const withDetails = renderPanels({ isDetailsOpen: true });

        swipeLeftOn(message);

        expect(withDetails.setIsDetailsOpen)
            .not.toHaveBeenCalled();

        swipeRightOn(message);

        expect(withDetails.setIsDetailsOpen)
            .toHaveBeenCalledWith(false);
        expect(withDetails.setIsListOpen)
            .not.toHaveBeenCalled();
    });

    it('opens no details where there is no chat with a bot', () => {
        const spies = renderPanels({ canOpenDetails: false });

        swipeLeftOn(addParagraph());

        expect(spies.setIsDetailsOpen)
            .not.toHaveBeenCalled();
    });

    it('leaves a drag on the bot screen, a dialog or a field to them', () => {
        const spies = renderPanels();
        const screenPanel = document.createElement('section');
        const dialog = document.createElement('dialog');
        const dialogText = document.createElement('p');
        const field = document.createElement('select');

        screenPanel.className = 'desktop-panel';
        dialog.append(dialogText);
        document.body.append(screenPanel, dialog, field);

        [screenPanel, dialogText, field].forEach((element) => {
            swipeRightOn(element);
            swipeLeftOn(element);
        });

        expect(spies.setIsListOpen)
            .not.toHaveBeenCalled();
        expect(spies.setIsDetailsOpen)
            .not.toHaveBeenCalled();
    });

    it('leaves a drag inside anything that scrolls sideways to it, also at the end of its scroll', () => {
        const spies = renderPanels();
        const scroller = document.createElement('div');
        const chip = document.createElement('button');

        scroller.style.overflowX = 'auto';
        Object.defineProperty(scroller, 'scrollWidth', { value: 600 });
        Object.defineProperty(scroller, 'clientWidth', { value: 300 });
        scroller.scrollLeft = 300;
        scroller.append(chip);
        document.body.append(scroller);

        swipeRightOn(chip);
        swipeLeftOn(chip);

        expect(spies.setIsListOpen)
            .not.toHaveBeenCalled();
        expect(spies.setIsDetailsOpen)
            .not.toHaveBeenCalled();
    });

    it('still swipes on a scroller with nothing to scroll', () => {
        const spies = renderPanels();
        const scroller = document.createElement('div');

        scroller.style.overflowX = 'auto';
        Object.defineProperty(scroller, 'scrollWidth', { value: 300 });
        Object.defineProperty(scroller, 'clientWidth', { value: 300 });
        document.body.append(scroller);

        swipeRightOn(scroller);

        expect(spies.setIsListOpen)
            .toHaveBeenCalledWith(true);
    });
});
