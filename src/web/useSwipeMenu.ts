import { useEffect } from 'react';

interface TouchPoint {
    x: number;
    y: number;
}

type SwipeDirection = 'right' | 'left';

type DragTarget = 'openList' | 'closeList' | 'page';

interface SwipePanels {
    isListOpen: boolean;
    setIsListOpen: (isOpen: boolean) => void;
    isDetailsOpen: boolean;
    setIsDetailsOpen: (isOpen: boolean) => void;
    // False where there is no chat with a bot on screen, so there are no details to open.
    canOpenDetails: boolean;
}

interface SwipeState {
    start: TouchPoint | undefined;
    // Chosen once the drag is clearly sideways, so turning back does not switch to another panel.
    target: DragTarget | undefined;
    element: HTMLElement | null;
}

const NARROW_SCREEN_QUERY = '(max-width: 720px)';
const MIN_SWIPE_DISTANCE_PX = 60;
// A drag on these belongs to them, whatever they hold: fields, code, dialogs and the bot's screen.
const OWN_DRAG_SELECTOR = 'pre, code, table, input, textarea, select, dialog, [role="dialog"], .composer, .desktop-panel';
// Browsers round these sizes, so one pixel of difference is not something to scroll.
const SCROLL_TOLERANCE_PX = 1;
// A drag shows only once it is clearly sideways, so a scroll does not shake the page.
const DRAG_START_PX = 10;
const PAGE_PULL_RATIO = 0.4;

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

// What a drag in this direction moves: the bot list, the page in the main column, or nothing. Mirrors applySwipe.
function readDragTarget(direction: SwipeDirection, panels: SwipePanels): DragTarget | undefined {
    if (direction === 'right') {
        if (panels.isDetailsOpen) {
            return 'page';
        }

        return panels.isListOpen ? undefined : 'openList';
    }

    if (panels.isListOpen) {
        return 'closeList';
    }

    return !panels.isDetailsOpen && panels.canOpenDetails ? 'page' : undefined;
}

// The list follows the finger. The page only leans toward it, as if pulled.
function dragTransform(target: DragTarget, distanceX: number): string {
    if (target === 'openList') {
        const shownPx = Math.max(distanceX, 0);

        return `translateX(calc(-100% + ${String(shownPx)}px))`;
    }

    if (target === 'closeList') {
        const hiddenPx = Math.min(distanceX, 0);

        return `translateX(${String(hiddenPx)}px)`;
    }

    return `translateX(${String(distanceX * PAGE_PULL_RATIO)}px)`;
}

function findDragElement(target: DragTarget): HTMLElement | null {
    const selector = target === 'page' ? '.main-column' : '.bot-list';

    return document.querySelector<HTMLElement>(selector);
}

// Without the inline styles, the stylesheet transition carries the element from where the finger left it.
function releaseDrag(swipe: SwipeState): void {
    swipe.element?.style.removeProperty('transform');
    swipe.element?.style.removeProperty('transition');
    swipe.element = null;
    swipe.target = undefined;
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
// brings in what is on the left, and a swipe to the left brings in what is on the right. While the finger moves,
// the list follows it and the page leans toward it.
function useSwipeMenu(panels: SwipePanels): void {
    const { isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails } = panels;

    useEffect(() => {
        const narrowScreen = window.matchMedia(NARROW_SCREEN_QUERY);
        const current: SwipePanels = { isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails };
        const swipe: SwipeState = { start: undefined, target: undefined, element: null };

        const handleTouchStart = (event: TouchEvent): void => {
            const target = event.target instanceof Element ? event.target : undefined;
            const isOwned = target !== undefined && ownsDrag(target);

            releaseDrag(swipe);
            swipe.start = isOwned || event.touches.length !== 1 ? undefined : readTouchPoint(event.touches[0]);
        };

        const handleTouchMove = (event: TouchEvent): void => {
            const start = swipe.start;
            const point = readTouchPoint(event.touches[0]);

            if (!narrowScreen.matches || start === undefined || point === undefined) {
                return;
            }

            const distanceX = point.x - start.x;
            const distanceY = point.y - start.y;
            const direction: SwipeDirection = distanceX > 0 ? 'right' : 'left';
            const isSideways = Math.abs(distanceX) >= DRAG_START_PX && Math.abs(distanceX) > Math.abs(distanceY) * 2;

            if (swipe.target === undefined && isSideways) {
                swipe.target = readDragTarget(direction, current);
                swipe.element = swipe.target === undefined ? null : findDragElement(swipe.target);
            }

            if (swipe.element === null || swipe.target === undefined) {
                return;
            }

            swipe.element.style.transition = 'none';
            swipe.element.style.transform = dragTransform(swipe.target, distanceX);
        };

        const handleTouchEnd = (event: TouchEvent): void => {
            const start = swipe.start;
            const end = readTouchPoint(event.changedTouches[0]);

            swipe.start = undefined;
            releaseDrag(swipe);

            if (!narrowScreen.matches || start === undefined || end === undefined) {
                return;
            }

            const direction = readSwipe(start, end);

            if (direction !== undefined) {
                applySwipe(direction, current);
            }
        };

        const handleTouchCancel = (): void => {
            swipe.start = undefined;
            releaseDrag(swipe);
        };

        document.addEventListener('touchstart', handleTouchStart, { passive: true });
        document.addEventListener('touchmove', handleTouchMove, { passive: true });
        document.addEventListener('touchend', handleTouchEnd, { passive: true });
        document.addEventListener('touchcancel', handleTouchCancel, { passive: true });

        return () => {
            releaseDrag(swipe);
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
            document.removeEventListener('touchcancel', handleTouchCancel);
        };
    }, [isListOpen, setIsListOpen, isDetailsOpen, setIsDetailsOpen, canOpenDetails]);
}

export { NARROW_SCREEN_QUERY, readSwipe, useSwipeMenu };
export type { SwipeDirection, SwipePanels, TouchPoint };
