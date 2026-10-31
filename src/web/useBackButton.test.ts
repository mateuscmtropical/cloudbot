// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBackButton } from './useBackButton.ts';

interface LayerProps {
    isOpen: boolean;
}

// A browser history: the entries of the app, the current one, and how often a back press would have left the app.
// Like Chrome, history.go picks its target entry when it is called and lands later, so a pushState in between is undone.
interface FakeHistory {
    entries: unknown[];
    index: number;
    leftAppCount: number;
}

const history: FakeHistory = { entries: [null], index: 0, leftAppCount: 0 };

function land(target: number): void {
    if (target < 0) {
        history.leftAppCount += 1;

        return;
    }

    history.index = target;
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.entries[target] }));
}

function goLater(delta: number): void {
    const target = history.index + delta;

    queueMicrotask(() => {
        land(target);
    });
}

function pressBack(): void {
    act(() => {
        land(history.index - 1);
    });
}

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
    });
}

describe('useBackButton', () => {
    beforeEach(() => {
        history.entries = [null];
        history.index = 0;
        history.leftAppCount = 0;
        vi.spyOn(window.history, 'state', 'get')
            .mockImplementation(() => history.entries[history.index]);
        vi.spyOn(window.history, 'pushState')
            .mockImplementation((state: unknown) => {
                history.entries = [...history.entries.slice(0, history.index + 1), state];
                history.index += 1;
            });
        vi.spyOn(window.history, 'replaceState')
            .mockImplementation((state: unknown) => {
                history.entries[history.index] = state;
            });
        vi.spyOn(window.history, 'back')
            .mockImplementation(() => {
                goLater(-1);
            });
        vi.spyOn(window.history, 'go')
            .mockImplementation((delta?: number) => {
                goLater(delta ?? 0);
            });
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    it('closes only the newest open layer on each back press', () => {
        const closeLower = vi.fn();
        const closeUpper = vi.fn();

        renderHook(() => {
            useBackButton(true, closeLower);
        });
        renderHook(() => {
            useBackButton(true, closeUpper);
        });

        pressBack();

        expect(closeUpper)
            .toHaveBeenCalledTimes(1);
        expect(closeLower)
            .not
            .toHaveBeenCalled();

        pressBack();

        expect(closeLower)
            .toHaveBeenCalledTimes(1);
    });

    it('takes its entry back when the layer closes another way, without closing the layer below', async () => {
        const closeLower = vi.fn();
        const closeUpper = vi.fn();

        renderHook(() => {
            useBackButton(true, closeLower);
        });

        const upper = renderHook((props: LayerProps) => {
            useBackButton(props.isOpen, closeUpper);
        }, { initialProps: { isOpen: true } });

        upper.rerender({ isOpen: false });
        await settle();

        expect(history.index)
            .toBe(1);
        expect(closeLower)
            .not
            .toHaveBeenCalled();

        pressBack();

        expect(closeLower)
            .toHaveBeenCalledTimes(1);
        expect(closeUpper)
            .not
            .toHaveBeenCalled();
    });

    it('never leaves the app when one layer closes and another opens in the same tap', async () => {
        const first = renderHook((props: LayerProps) => {
            useBackButton(props.isOpen, vi.fn());
        }, { initialProps: { isOpen: true } });
        const second = renderHook((props: LayerProps) => {
            useBackButton(props.isOpen, vi.fn());
        }, { initialProps: { isOpen: false } });

        act(() => {
            first.rerender({ isOpen: false });
            second.rerender({ isOpen: true });
        });
        await settle();

        second.rerender({ isOpen: false });
        await settle();

        first.rerender({ isOpen: true });
        first.rerender({ isOpen: false });
        await settle();

        expect(history.leftAppCount)
            .toBe(0);
        expect(history.index)
            .toBe(0);
    });
});
