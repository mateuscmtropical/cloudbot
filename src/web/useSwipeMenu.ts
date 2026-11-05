import { useEffect } from 'react';

interface TouchPoint {
    x: number;
    y: number;
}

type SwipeDirection = 'right' | 'left';

interface SwipePanels {
    isListOpen: boolean;
    setIsListOpen: (isOpen: boolean) => void;
    isDetailsOpen: boolean;
    setIsDetailsOpen: (isOpen: boolean) => void;
    // False where there is no chat with a bot on screen, so there are no details to open.
    canOpenDetails: boolean;
}

const NARROW_SCREEN_QUERY = '(max-width: 720px)';
const MIN_SWIPE_DISTANCE_PX = 60;
// A drag on these belongs to them, whatever they hold: fields, code, dialogs and the bot's screen.
const OWN_DRAG_SELECTOR = 'pre, code, table, input, textarea, select, dialog, [role="dialog"], .composer, .desktop-panel';
// Browsers round these sizes, so one pixel of difference is not something to scroll.
const SCROLL_TOLERANCE_PX = 1;

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

function scrollsSideways(element: Element): boolean {
    if (element.scrollWidth <= element.clientWidth + SCROLL_TOLERANCE_PX) {
        return false;
    }

    const { overflowX } = window.getComputedStyle(element);

    return overflowX === 'auto' || overflowX === 'scroll';
}

// Anything that scrolls sideways keeps the drag, also at the end of its scroll, so the drag never changes meaning halfway.
function ownsDrag(element: Element): boolean {
    if (element.matches(OWN_DRAG_SELECTOR) || scrollsSideways(element)) {
        return true;
    }

    return element.parentElement !== null && ownsDrag(element.parentElement);
}

function applySwipe(direction: SwipeDirection, panels: SwipePanels): void {
    if (direction === 'right') {
        if (panels.isDetailsOpen) {
            panels.setIsDetailsOpen(false);
        } else if (!panels.isListOpen) {
            panels.setIsListOpen(true);
        }

        return;
    }

    if (panels.isListOpen) {
        panels.setIsListOpen(false);
    } else if (!panels.isDetailsOpen && panels.canOpenDetails) {
        panels.setIsDetailsOpen(true);
    }
}

// On a phone, the bot list sits to the left of the chat and the bot's details to the right. A swipe to the right
// brings in what is on the left, and a swipe to the left brings in what is on the right.
function useSwipeMenu(panels: SwipePanels): void {
    const { isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails } = panels;

    useEffect(() => {
        const narrowScreen = window.matchMedia(NARROW_SCREEN_QUERY);
        const swipe: { start: TouchPoint | undefined } = { start: undefined };

        const handleTouchStart = (event: TouchEvent): void => {
            const target = event.target instanceof Element ? event.target : undefined;
            const isOwned = target !== undefined && ownsDrag(target);

            swipe.start = isOwned || event.touches.length !== 1 ? undefined : readTouchPoint(event.touches[0]);
        };

        const handleTouchEnd = (event: TouchEvent): void => {
            const start = swipe.start;
            const end = readTouchPoint(event.changedTouches[0]);

            swipe.start = undefined;

            if (!narrowScreen.matches || start === undefined || end === undefined) {
                return;
            }

            const direction = readSwipe(start, end);

            if (direction !== undefined) {
                applySwipe(direction, { isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails });
            }
        };

        document.addEventListener('touchstart', handleTouchStart, { passive: true });
        document.addEventListener('touchend', handleTouchEnd, { passive: true });

        return () => {
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchend', handleTouchEnd);
        };
    }, [isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails]);
}

export { NARROW_SCREEN_QUERY, readSwipe, useSwipeMenu };
export type { SwipeDirection, SwipePanels, TouchPoint };
