import { useEffect } from 'react';

interface TouchPoint {
    x: number;
    y: number;
}

type SwipeDirection = 'right' | 'left';

const NARROW_SCREEN_QUERY = '(max-width: 720px)';
const MIN_SWIPE_DISTANCE_PX = 60;
// A drag that runs in a text field, a code block, the composer or the bot's screen belongs to that element, not to the menu.
const OWN_DRAG_SELECTOR = 'pre, code, table, input, textarea, .composer, .desktop-panel';

// A swipe is a mostly horizontal drag that is long enough. A slow diagonal scroll is not one.
function readSwipe(start: TouchPoint, end: TouchPoint): SwipeDirection | undefined {
    const distanceX = end.x - start.x;
    const distanceY = end.y - start.y;
    const isLongEnough = Math.abs(distanceX) >= MIN_SWIPE_DISTANCE_PX;
    const isHorizontal = Math.abs(distanceX) > Math.abs(distanceY) * 2;

    if (!isLongEnough || !isHorizontal) {
        return undefined;
    }

    return distanceX > 0 ? 'right' : 'left';
}

function readTouchPoint(touch: Touch | undefined): TouchPoint | undefined {
    if (touch === undefined) {
        return undefined;
    }

    return { x: touch.clientX, y: touch.clientY };
}

// On a phone, a swipe to the right opens the bot list and a swipe to the left closes it.
function useSwipeMenu(isOpen: boolean, setIsOpen: (isOpen: boolean) => void): void {
    useEffect(() => {
        const narrowScreen = window.matchMedia(NARROW_SCREEN_QUERY);
        const swipe: { start: TouchPoint | undefined } = { start: undefined };

        const handleTouchStart = (event: TouchEvent): void => {
            const target = event.target instanceof Element ? event.target : undefined;
            const ownsDrag = target !== undefined && target.closest(OWN_DRAG_SELECTOR) !== null;

            swipe.start = ownsDrag || event.touches.length !== 1 ? undefined : readTouchPoint(event.touches[0]);
        };

        const handleTouchEnd = (event: TouchEvent): void => {
            const start = swipe.start;
            const end = readTouchPoint(event.changedTouches[0]);

            swipe.start = undefined;

            if (!narrowScreen.matches || start === undefined || end === undefined) {
                return;
            }

            const direction = readSwipe(start, end);

            if (direction === 'right' && !isOpen) {
                setIsOpen(true);
            }

            if (direction === 'left' && isOpen) {
                setIsOpen(false);
            }
        };

        document.addEventListener('touchstart', handleTouchStart, { passive: true });
        document.addEventListener('touchend', handleTouchEnd, { passive: true });

        return () => {
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchend', handleTouchEnd);
        };
    }, [isOpen, setIsOpen]);
}

export { readSwipe, useSwipeMenu };
export type { SwipeDirection, TouchPoint };
