// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDelayedFlag } from './useDelayedFlag.ts';

interface FlagProps {
    flag: boolean;
}

function renderFlag(flag: boolean): RenderHookResult<boolean, FlagProps> {
    return renderHook(({ flag: currentFlag }: FlagProps) => useDelayedFlag(currentFlag, 300), { initialProps: { flag } });
}

describe('useDelayedFlag', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('turns true only after the flag has stayed true for the delay', () => {
        const { result } = renderFlag(true);

        expect(result.current)
            .toBe(false);

        act(() => {
            vi.advanceTimersByTime(299);
        });

        expect(result.current)
            .toBe(false);

        act(() => {
            vi.advanceTimersByTime(1);
        });

        expect(result.current)
            .toBe(true);
    });

    it('hides at once when the flag drops', () => {
        const { result, rerender } = renderFlag(true);

        act(() => {
            vi.advanceTimersByTime(300);
        });
        rerender({ flag: false });

        expect(result.current)
            .toBe(false);
    });

    it('restarts the delay when the flag comes back', () => {
        const { result, rerender } = renderFlag(true);

        act(() => {
            vi.advanceTimersByTime(300);
        });
        rerender({ flag: false });
        rerender({ flag: true });

        expect(result.current)
            .toBe(false);

        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(result.current)
            .toBe(true);
    });

    it('clears its timer on unmount', () => {
        const { unmount } = renderFlag(true);

        unmount();

        expect(() => {
            vi.advanceTimersByTime(300);
        })
            .not.toThrow();
    });
});
