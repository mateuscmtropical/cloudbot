interface Point {
    x: number;
    y: number;
}

type PointListener = (point: Point) => void;

// The distance from the face at which the eyes reach their full offset. A closer pointer moves them less.
const FULL_OFFSET_DISTANCE_PX = 120;

// How far the eyes move toward a point, in the same units as maxOffset. Zero when the point is on the eyes.
function computeEyeOffset(from: Point, to: Point, maxOffset: number): Point {
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    const distance = Math.hypot(deltaX, deltaY);

    if (distance === 0) {
        return { x: 0, y: 0 };
    }

    const offsetLength = Math.min(maxOffset, maxOffset * distance / FULL_OFFSET_DISTANCE_PX);
    const scale = offsetLength / distance;

    return { x: deltaX * scale, y: deltaY * scale };
}

// One listener on the window serves every mascot. Pointer moves are batched into one call per animation frame.
const listeners = new Set<PointListener>();
let latestPoint: Point | undefined;
let frameRequest: number | undefined;

function notifyListeners(): void {
    frameRequest = undefined;

    if (latestPoint === undefined) {
        return;
    }

    const point = latestPoint;

    listeners.forEach((listener) => {
        listener(point);
    });
}

function handlePointer(event: PointerEvent): void {
    latestPoint = { x: event.clientX, y: event.clientY };

    if (frameRequest === undefined) {
        frameRequest = window.requestAnimationFrame(notifyListeners);
    }
}

// Returns a function that stops the listener. The window listeners go when the last listener stops.
function subscribeToPointer(listener: PointListener): () => void {
    if (listeners.size === 0) {
        window.addEventListener('pointermove', handlePointer);
        window.addEventListener('pointerdown', handlePointer);
    }

    listeners.add(listener);

    return () => {
        listeners.delete(listener);

        if (listeners.size > 0) {
            return;
        }

        window.removeEventListener('pointermove', handlePointer);
        window.removeEventListener('pointerdown', handlePointer);

        if (frameRequest !== undefined) {
            window.cancelAnimationFrame(frameRequest);
            frameRequest = undefined;
        }

        latestPoint = undefined;
    };
}

export { computeEyeOffset, subscribeToPointer };
export type { Point, PointListener };
