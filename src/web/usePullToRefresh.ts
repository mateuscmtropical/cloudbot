import { useEffect, useRef, useState } from 'react';

import { canStartPullToRefresh, measurePullDistance, shouldRefreshAfterPull } from './pullToRefresh.ts';
import type { PullStartState } from './pullToRefresh.ts';

interface TouchStartPoint {
    x: number;
    y: number;
}

interface PullGesture {
    start: TouchStartPoint;
    lastY: number;
}

interface PullToRefreshState {
    distance: number;
    isRefreshing: boolean;
}

const REFRESH_INDICATOR_MS = 120;

function readScrollableAncestorTops(target: Element): number[] {
    const scrollTops: number[] = [];

    function visit(element: Element | null): void {
        if (element === null) {
            return;
        }

        const overflowY = window.getComputedStyle(element).overflowY;
        const isScrollable = /^(auto|scroll|overlay)$/.test(overflowY) && element.scrollHeight > element.clientHeight;

        if (isScrollable) {
            scrollTops.push(element.scrollTop);
        }

        visit(element.parentElement);
    }

    visit(target);

    return scrollTops;
}

function isBlockedPullTarget(target: Element): boolean {
    const formOrProtectedAncestor = target.closest('input, textarea, select, [data-no-pull]');
    const editableAncestor = target.closest('[contenteditable]');
    const editableAttribute = editableAncestor?.getAttribute('contenteditable');
    const editableValue = editableAttribute?.toLowerCase();

    return formOrProtectedAncestor !== null || (editableAncestor !== null && editableValue !== 'false');
}

function readPullStartState(target: Element): PullStartState {
    return {
        isBlocked: isBlockedPullTarget(target),
        scrollableAncestorTops: readScrollableAncestorTops(target),
    };
}

function readTouchPoint(touch: Touch | undefined): TouchStartPoint | undefined {
    if (touch === undefined) {
        return undefined;
    }

    return { x: touch.clientX, y: touch.clientY };
}

function reloadCurrentPage(): void {
    window.location.reload();
}

function usePullToRefresh(reloadPage: () => void = reloadCurrentPage): PullToRefreshState {
    const [distance, setDistance] = useState(0);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const gestureRef = useRef<PullGesture | undefined>(undefined);
    const reloadTimerRef = useRef<number | undefined>(undefined);
    const isRefreshingRef = useRef(false);

    useEffect(() => {
        const cancelGesture = (): void => {
            gestureRef.current = undefined;
            setDistance(0);
        };

        const handleTouchStart = (event: TouchEvent): void => {
            if (isRefreshingRef.current || event.touches.length !== 1) {
                cancelGesture();

                return;
            }

            const target = event.target instanceof Element ? event.target : undefined;
            const touch = readTouchPoint(event.touches[0]);

            if (target === undefined || touch === undefined) {
                cancelGesture();

                return;
            }

            const startState = readPullStartState(target);

            if (!canStartPullToRefresh(startState)) {
                cancelGesture();

                return;
            }

            gestureRef.current = { start: touch, lastY: touch.y };
        };

        const handleTouchMove = (event: TouchEvent): void => {
            const gesture = gestureRef.current;

            if (gesture === undefined) {
                return;
            }

            if (event.touches.length !== 1) {
                cancelGesture();

                return;
            }

            const touch = readTouchPoint(event.touches[0]);

            if (touch === undefined) {
                cancelGesture();

                return;
            }

            const deltaX = touch.x - gesture.start.x;

            if (touch.y < gesture.lastY) {
                cancelGesture();

                return;
            }

            gesture.lastY = touch.y;
            const deltaY = touch.y - gesture.start.y;
            const nextDistance = measurePullDistance(deltaY);

            setDistance(nextDistance);

            if (deltaY > 0 && deltaY >= Math.abs(deltaX)) {
                event.preventDefault();
            }
        };

        const handleTouchEnd = (event: TouchEvent): void => {
            const gesture = gestureRef.current;

            if (gesture === undefined) {
                return;
            }

            if (event.touches.length !== 0) {
                cancelGesture();

                return;
            }

            const touch = readTouchPoint(event.changedTouches[0]);

            if (touch === undefined || touch.y < gesture.lastY) {
                cancelGesture();

                return;
            }

            const finalDistance = measurePullDistance(touch.y - gesture.start.y);

            gestureRef.current = undefined;

            if (!shouldRefreshAfterPull(finalDistance)) {
                setDistance(0);

                return;
            }

            isRefreshingRef.current = true;
            setDistance(finalDistance);
            setIsRefreshing(true);
            reloadTimerRef.current = window.setTimeout(reloadPage, REFRESH_INDICATOR_MS);
        };

        const handleTouchCancel = (): void => {
            cancelGesture();
        };

        document.addEventListener('touchstart', handleTouchStart, { passive: true });
        document.addEventListener('touchmove', handleTouchMove, { passive: false });
        document.addEventListener('touchend', handleTouchEnd, { passive: true });
        document.addEventListener('touchcancel', handleTouchCancel, { passive: true });

        return () => {
            document.removeEventListener('touchstart', handleTouchStart);
            document.removeEventListener('touchmove', handleTouchMove);
            document.removeEventListener('touchend', handleTouchEnd);
            document.removeEventListener('touchcancel', handleTouchCancel);

            if (reloadTimerRef.current !== undefined) {
                window.clearTimeout(reloadTimerRef.current);
            }
        };
    }, [reloadPage]);

    return { distance, isRefreshing };
}

export { usePullToRefresh };
export type { PullToRefreshState };
