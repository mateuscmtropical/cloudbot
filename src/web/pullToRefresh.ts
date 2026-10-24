interface PullStartState {
    isBlocked: boolean;
    scrollableAncestorTops: readonly number[];
}

const PULL_RESISTANCE = 0.5;
const PULL_TO_REFRESH_THRESHOLD = 70;

function canStartPullToRefresh(state: PullStartState): boolean {
    return !state.isBlocked && state.scrollableAncestorTops.every(scrollTop => scrollTop === 0);
}

function measurePullDistance(deltaY: number): number {
    if (!Number.isFinite(deltaY)) {
        return 0;
    }

    return Math.max(0, deltaY) * PULL_RESISTANCE;
}

function shouldRefreshAfterPull(distance: number): boolean {
    return distance >= PULL_TO_REFRESH_THRESHOLD;
}

export { canStartPullToRefresh, measurePullDistance, shouldRefreshAfterPull };
export type { PullStartState };
