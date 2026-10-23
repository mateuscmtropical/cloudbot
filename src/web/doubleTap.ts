// Two taps on the same thing within this many milliseconds are a double tap. A mouse click counts the same way.
const DOUBLE_TAP_MS = 350;

interface Tap {
    id: string;
    at: number;
}

interface TapResult {
    // What to remember for the next tap. Nothing after a double tap, so a third tap starts over.
    tap: Tap | undefined;
    isDouble: boolean;
}

// The browser's own double click event is not sent on every phone, so taps are counted here, by pointer events.
function nextTap(previous: Tap | undefined, id: string, at: number): TapResult {
    const isDouble = previous?.id === id && at - previous.at <= DOUBLE_TAP_MS;

    return isDouble ? { tap: undefined, isDouble: true } : { tap: { id, at }, isDouble: false };
}

export { DOUBLE_TAP_MS, nextTap };
export type { Tap, TapResult };
