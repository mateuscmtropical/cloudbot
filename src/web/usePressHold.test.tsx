// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePressHold } from './usePressHold.ts';

interface ProbeProps {
    onPressHold: () => void;
    onContextMenu: () => void;
    onClick: () => void;
}

function Probe({ onPressHold, onContextMenu, onClick }: ProbeProps): ReactElement {
    const handlers = usePressHold(onPressHold, onContextMenu);

    return (
        <button
            type="button"
            onPointerDown={handlers.onPointerDown}
            onPointerMove={handlers.onPointerMove}
            onPointerUp={handlers.onPointerUp}
            onPointerCancel={handlers.onPointerCancel}
            onClickCapture={handlers.onClickCapture}
            onContextMenu={handlers.onContextMenu}
            onClick={onClick}
        >
            Hold
        </button>
    );
}

function pressPointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'pointerCancel', target: HTMLElement, properties: Record<string, number | string> = {}): void {
    const eventProperties = { pointerType: 'touch', pointerId: 1, button: 0, clientX: 20, clientY: 20, ...properties };

    if (type === 'pointerDown') {
        fireEvent.pointerDown(target, eventProperties);

        return;
    }

    if (type === 'pointerMove') {
        fireEvent.pointerMove(target, eventProperties);

        return;
    }

    if (type === 'pointerUp') {
        fireEvent.pointerUp(target, eventProperties);

        return;
    }

    fireEvent.pointerCancel(target, eventProperties);
}

describe('usePressHold', () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('opens after 450 ms and suppresses the click from that hold', () => {
        vi.useFakeTimers();
        const onPressHold = vi.fn();
        const onClick = vi.fn();

        render(<Probe onPressHold={onPressHold} onContextMenu={vi.fn()} onClick={onClick} />);
        const button = screen.getByRole('button', { name: 'Hold' });

        pressPointer('pointerDown', button);
        vi.advanceTimersByTime(449);
        expect(onPressHold)
            .not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(onPressHold)
            .toHaveBeenCalledTimes(1);

        pressPointer('pointerUp', button);
        fireEvent.click(button);
        expect(onClick)
            .not.toHaveBeenCalled();
    });

    it('cancels when the finger lifts early or moves more than ten pixels', () => {
        vi.useFakeTimers();
        const onPressHold = vi.fn();

        render(<Probe onPressHold={onPressHold} onContextMenu={vi.fn()} onClick={vi.fn()} />);
        const button = screen.getByRole('button', { name: 'Hold' });

        pressPointer('pointerDown', button);
        vi.advanceTimersByTime(300);
        pressPointer('pointerUp', button);
        vi.advanceTimersByTime(200);

        pressPointer('pointerDown', button);
        pressPointer('pointerMove', button, { clientX: 31 });
        vi.advanceTimersByTime(500);

        expect(onPressHold)
            .not.toHaveBeenCalled();
    });

    it('suppresses the browser context menu and opens the same action menu', () => {
        const onContextMenu = vi.fn();

        render(<Probe onPressHold={vi.fn()} onContextMenu={onContextMenu} onClick={vi.fn()} />);
        const button = screen.getByRole('button', { name: 'Hold' });
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

        button.dispatchEvent(event);

        expect(event.defaultPrevented)
            .toBe(true);
        expect(onContextMenu)
            .toHaveBeenCalledTimes(1);
    });
});
