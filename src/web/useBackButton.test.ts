// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBackButton } from './useBackButton.ts';

interface LayerProps {
    isOpen: boolean;
}

function pressBack(): void {
    act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
    });
}

const back = vi.fn();

describe('useBackButton', () => {
    beforeEach(() => {
        vi.spyOn(window.history, 'pushState')
            .mockImplementation(() => undefined);
        back.mockClear();
        vi.spyOn(window.history, 'back')
            .mockImplementation(back);
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

    it('takes its entry back when the layer closes another way, without closing the layer below', () => {
        const closeLower = vi.fn();
        const closeUpper = vi.fn();

        renderHook(() => {
            useBackButton(true, closeLower);
        });

        const upper = renderHook((props: LayerProps) => {
            useBackButton(props.isOpen, closeUpper);
        }, { initialProps: { isOpen: true } });

        upper.rerender({ isOpen: false });

        expect(back)
            .toHaveBeenCalledTimes(1);

        // The pop of that history.back is ignored.
        pressBack();

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
});
