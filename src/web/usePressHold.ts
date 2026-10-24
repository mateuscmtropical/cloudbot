import { useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

const PRESS_HOLD_DURATION_MS = 450;
const PRESS_HOLD_MOVE_TOLERANCE = 10;

interface UsePressHoldHandlers {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onClickCapture: (event: MouseEvent<HTMLElement>) => void;
    onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    didTrigger: () => boolean;
}

interface PressPoint {
    pointerId: number;
    x: number;
    y: number;
}

function usePressHold(onPressHold?: () => void, onContextMenu?: () => void): UsePressHoldHandlers {
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const clickResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const pressPointRef = useRef<PressPoint | undefined>(undefined);
    const didTriggerRef = useRef(false);

    useEffect(() => () => {
        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
        }

        if (clickResetTimerRef.current !== undefined) {
            clearTimeout(clickResetTimerRef.current);
        }
    }, []);

    function onPointerDown(event: PointerEvent<HTMLElement>): void {
        if (onPressHold === undefined || event.button !== 0 || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) {
            return;
        }

        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
        }

        if (clickResetTimerRef.current !== undefined) {
            clearTimeout(clickResetTimerRef.current);
        }

        didTriggerRef.current = false;
        pressPointRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        timerRef.current = setTimeout(() => {
            didTriggerRef.current = true;
            onPressHold();
        }, PRESS_HOLD_DURATION_MS);
    }

    function onPointerMove(event: PointerEvent<HTMLElement>): void {
        const pressPoint = pressPointRef.current;

        if (pressPoint === undefined || event.pointerId !== pressPoint.pointerId) {
            return;
        }

        const movedX = event.clientX - pressPoint.x;
        const movedY = event.clientY - pressPoint.y;

        if (Math.hypot(movedX, movedY) > PRESS_HOLD_MOVE_TOLERANCE) {
            if (timerRef.current !== undefined) {
                clearTimeout(timerRef.current);
                timerRef.current = undefined;
            }

            pressPointRef.current = undefined;
        }
    }

    function onPointerUp(event: PointerEvent<HTMLElement>): void {
        const pressPoint = pressPointRef.current;

        if (pressPoint !== undefined && event.pointerId !== pressPoint.pointerId) {
            return;
        }

        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }

        pressPointRef.current = undefined;

        if (didTriggerRef.current) {
            clickResetTimerRef.current = setTimeout(() => {
                didTriggerRef.current = false;
                clickResetTimerRef.current = undefined;
            }, 0);
        }
    }

    function onPointerCancel(event: PointerEvent<HTMLElement>): void {
        const pressPoint = pressPointRef.current;

        if (pressPoint !== undefined && event.pointerId !== pressPoint.pointerId) {
            return;
        }

        if (timerRef.current !== undefined) {
            clearTimeout(timerRef.current);
            timerRef.current = undefined;
        }

        pressPointRef.current = undefined;
        didTriggerRef.current = false;
    }

    function onClickCapture(event: MouseEvent<HTMLElement>): void {
        if (!didTriggerRef.current) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        didTriggerRef.current = false;

        if (clickResetTimerRef.current !== undefined) {
            clearTimeout(clickResetTimerRef.current);
            clickResetTimerRef.current = undefined;
        }
    }

    function handleContextMenu(event: MouseEvent<HTMLElement>): void {
        event.preventDefault();
        onContextMenu?.();
    }

    function didTrigger(): boolean {
        return didTriggerRef.current;
    }

    return {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onClickCapture,
        onContextMenu: handleContextMenu,
        didTrigger,
    };
}

export { usePressHold };
export type { UsePressHoldHandlers };
