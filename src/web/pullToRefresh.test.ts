import { describe, expect, it } from 'vitest';

import { canStartPullToRefresh, measurePullDistance, shouldRefreshAfterPull } from './pullToRefresh.ts';

describe('canStartPullToRefresh', () => {
    it('allows an unblocked target when every scrollable ancestor is at the top', () => {
        expect(canStartPullToRefresh({ isBlocked: false, scrollableAncestorTops: [0, 0] }))
            .toBe(true);
    });

    it('refuses blocked targets and scrolled ancestors', () => {
        expect(canStartPullToRefresh({ isBlocked: true, scrollableAncestorTops: [0] }))
            .toBe(false);
        expect(canStartPullToRefresh({ isBlocked: false, scrollableAncestorTops: [0, 24] }))
            .toBe(false);
        expect(canStartPullToRefresh({ isBlocked: false, scrollableAncestorTops: [-1] }))
            .toBe(false);
    });
});

describe('pull distance', () => {
    it('applies half resistance and ignores movement above the starting point', () => {
        expect(measurePullDistance(80))
            .toBe(40);
        expect(measurePullDistance(-10))
            .toBe(0);
        expect(measurePullDistance(Number.NaN))
            .toBe(0);
    });

    it('reaches the reload threshold at 70 resisted pixels', () => {
        expect(shouldRefreshAfterPull(69.5))
            .toBe(false);
        expect(shouldRefreshAfterPull(70))
            .toBe(true);
    });
});
