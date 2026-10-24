// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePullToRefresh } from './usePullToRefresh.ts';

interface TestTouch {
    clientX: number;
    clientY: number;
}

function createTouchEvent(type: string, touches: TestTouch[], changedTouches: TestTouch[] = touches): TouchEvent {
    const event = new Event(type, { bubbles: true, cancelable: true });

    Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: changedTouches },
    });

    return event as unknown as TouchEvent;
}

function touch(clientX: number, clientY: number): TestTouch {
    return { clientX, clientY };
}

function dispatchTouch(target: Element, type: string, touches: TestTouch[], changedTouches?: TestTouch[]): TouchEvent {
    const event = createTouchEvent(type, touches, changedTouches);

    target.dispatchEvent(event);

    return event;
}

function createScrollableAncestor(scrollTop: number): HTMLDivElement {
    const ancestor = document.createElement('div');
    const child = document.createElement('div');

    ancestor.style.overflowY = 'auto';
    Object.defineProperties(ancestor, {
        scrollHeight: { configurable: true, value: 500 },
        clientHeight: { configurable: true, value: 100 },
    });
    ancestor.scrollTop = scrollTop;
    ancestor.append(child);
    document.body.append(ancestor);

    return child;
}

describe('usePullToRefresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('tracks a resisted downward pull, prevents that move and reloads at the threshold', () => {
        const reloadPage = vi.fn();
        const target = document.createElement('div');

        document.body.append(target);
        const { result, unmount } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(20, 10)]);
        });
        const moveEvent = createTouchEvent('touchmove', [touch(20, 90)]);

        act(() => {
            target.dispatchEvent(moveEvent);
        });

        expect(moveEvent.defaultPrevented)
            .toBe(true);
        expect(result.current.distance)
            .toBe(40);

        act(() => {
            dispatchTouch(target, 'touchend', [], [touch(20, 150)]);
        });

        expect(result.current.isRefreshing)
            .toBe(true);
        expect(reloadPage)
            .not.toHaveBeenCalled();

        act(() => {
            vi.advanceTimersByTime(120);
        });

        expect(reloadPage)
            .toHaveBeenCalledTimes(1);
        unmount();
    });

    it('does not prevent a horizontal move or reload below the threshold', () => {
        const reloadPage = vi.fn();
        const target = document.createElement('div');

        document.body.append(target);
        const { result } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(10, 10)]);
        });
        const moveEvent = createTouchEvent('touchmove', [touch(30, 20)]);

        act(() => {
            target.dispatchEvent(moveEvent);
        });

        expect(moveEvent.defaultPrevented)
            .toBe(false);
        expect(result.current.distance)
            .toBe(5);

        act(() => {
            dispatchTouch(target, 'touchend', [], [touch(30, 149)]);
            vi.advanceTimersByTime(120);
        });

        expect(reloadPage)
            .not.toHaveBeenCalled();
    });

    it('does not start inside fields or data-no-pull surfaces', () => {
        const reloadPage = vi.fn();
        const input = document.createElement('input');
        const protectedSurface = document.createElement('div');
        const editableSurface = document.createElement('div');

        protectedSurface.setAttribute('data-no-pull', '');
        editableSurface.setAttribute('contenteditable', '');
        document.body.append(input, protectedSurface, editableSurface);
        const { result } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(input, 'touchstart', [touch(0, 0)]);
            dispatchTouch(input, 'touchmove', [touch(0, 160)]);
            dispatchTouch(protectedSurface, 'touchstart', [touch(0, 0)]);
            dispatchTouch(protectedSurface, 'touchmove', [touch(0, 160)]);
            dispatchTouch(editableSurface, 'touchstart', [touch(0, 0)]);
            dispatchTouch(editableSurface, 'touchmove', [touch(0, 160)]);
        });

        expect(result.current.distance)
            .toBe(0);
        expect(reloadPage)
            .not.toHaveBeenCalled();
    });

    it('waits for every scrollable ancestor to return to the top', () => {
        const reloadPage = vi.fn();
        const target = createScrollableAncestor(1);
        const { result } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(0, 0)]);
            dispatchTouch(target, 'touchmove', [touch(0, 160)]);
        });

        expect(result.current.distance)
            .toBe(0);
    });

    it('cancels when the finger moves up, a second finger lands or touch is cancelled', () => {
        const reloadPage = vi.fn();
        const target = document.createElement('div');

        document.body.append(target);
        const { result } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(0, 100)]);
            dispatchTouch(target, 'touchmove', [touch(0, 99)]);
        });
        expect(result.current.distance)
            .toBe(0);

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(0, 0)]);
            dispatchTouch(target, 'touchmove', [touch(0, 50)]);
            dispatchTouch(target, 'touchstart', [touch(0, 50), touch(1, 50)]);
        });
        expect(result.current.distance)
            .toBe(0);

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(0, 0)]);
            dispatchTouch(target, 'touchmove', [touch(0, 50)]);
            dispatchTouch(target, 'touchcancel', []);
        });
        expect(result.current.distance)
            .toBe(0);
        expect(reloadPage)
            .not.toHaveBeenCalled();
    });

    it('cancels if the finger retreats before release even when it stays below the starting point', () => {
        const reloadPage = vi.fn();
        const target = document.createElement('div');

        document.body.append(target);
        renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            dispatchTouch(target, 'touchstart', [touch(0, 0)]);
            dispatchTouch(target, 'touchmove', [touch(0, 150)]);
            dispatchTouch(target, 'touchmove', [touch(0, 140)]);
            dispatchTouch(target, 'touchend', [], [touch(0, 140)]);
            vi.advanceTimersByTime(120);
        });

        expect(reloadPage)
            .not.toHaveBeenCalled();
    });

    it('does nothing for mouse input', () => {
        const reloadPage = vi.fn();
        const target = document.createElement('div');

        document.body.append(target);
        const { result } = renderHook(() => usePullToRefresh(reloadPage));

        act(() => {
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });

        expect(result.current.distance)
            .toBe(0);
        expect(reloadPage)
            .not.toHaveBeenCalled();
    });
});
