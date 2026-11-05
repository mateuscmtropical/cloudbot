import { path } from 'ghost-cursor';

interface CursorPoint {
    x: number;
    y: number;
}

interface CursorStep extends CursorPoint {
    // The wait before this step, so the whole move takes the time a hand would.
    waitMs: number;
}

interface TimedPoint extends CursorPoint {
    timestamp: number;
}

const PRESS_MIN_MS = 50;
const PRESS_SPREAD_MS = 70;

function readTimestamp(point: CursorPoint): number {
    return 'timestamp' in point && typeof point.timestamp === 'number' ? point.timestamp : 0;
}

// A curved move from one point to another, with the speed of a hand, from ghost-cursor. The points stay on the page.
function cursorSteps(from: CursorPoint, to: CursorPoint): CursorStep[] {
    const points = path(from, to, { useTimestamps: true });
    const timed: TimedPoint[] = points.map(point => ({ x: Math.max(point.x, 0), y: Math.max(point.y, 0), timestamp: readTimestamp(point) }));

    return timed.map((point, index) => {
        const previous = timed[index - 1] ?? point;

        return { x: point.x, y: point.y, waitMs: Math.max(point.timestamp - previous.timestamp, 0) };
    });
}

// How long the button stays down, like a real click.
function pressHoldMs(random: () => number = Math.random): number {
    const spread = random() * PRESS_SPREAD_MS;

    return PRESS_MIN_MS + Math.round(spread);
}

export { cursorSteps, pressHoldMs };
export type { CursorPoint, CursorStep };
