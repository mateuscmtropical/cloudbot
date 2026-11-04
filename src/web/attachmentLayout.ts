// Six columns: a row of three, of two, or one wide tile. Only the first row changes, so the mosaic always ends in full rows.
const GRID_COLUMNS = 6;
const SWIPE_MIN_PIXELS = 50;
// Space for a stored image with no known size, such as one from before the size was saved.
const DEFAULT_RATIO = 4 / 3;
const MIN_RATIO = 0.5;
const MAX_RATIO = 2.5;

function mosaicSpan(index: number, count: number): number {
    const leftover = count % 3;

    if (leftover === 1 && index === 0) {
        return GRID_COLUMNS;
    }

    if (leftover === 2 && index < 2) {
        return GRID_COLUMNS / 2;
    }

    return GRID_COLUMNS / 3;
}

// Very long images are kept to a sensible box. The lightbox shows them whole.
function singleImageRatio(width: number | undefined, height: number | undefined): number {
    if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        return DEFAULT_RATIO;
    }

    const atLeastMin = Math.max(MIN_RATIO, width / height);

    return Math.min(MAX_RATIO, atLeastMin);
}

// A swipe to the left goes to the next image. A mostly vertical move is not a swipe. Returns the images to move by.
function swipeStep(deltaX: number, deltaY: number): number {
    if (Math.abs(deltaX) < SWIPE_MIN_PIXELS || Math.abs(deltaX) <= Math.abs(deltaY)) {
        return 0;
    }

    return deltaX < 0 ? 1 : -1;
}

export { GRID_COLUMNS, mosaicSpan, singleImageRatio, swipeStep };
