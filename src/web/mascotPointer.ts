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

interface CaretBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

// The styles the mirror copies, so it wraps and spaces the text the way the text box does. Its width comes from the text box.
const MIRRORED_PROPERTIES = [
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-style',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-style', 'font-variant', 'font-weight',
    'font-stretch', 'font-size', 'font-family', 'font-kerning', 'font-feature-settings', 'text-rendering', 'line-height',
    'letter-spacing', 'word-spacing', 'text-transform', 'text-indent', 'tab-size', 'white-space', 'overflow-wrap',
    'word-break', 'text-align', 'direction',
];

interface CaretMirror {
    element: HTMLDivElement;
    marker: HTMLSpanElement;
}

// The one hidden mirror of the text boxes. It is made on first use and kept in the page, so typing creates no elements.
let caretMirror: CaretMirror | undefined;

function getCaretMirror(): CaretMirror {
    if (caretMirror !== undefined) {
        if (!caretMirror.element.isConnected) {
            document.body.appendChild(caretMirror.element);
        }

        return caretMirror;
    }

    const element = document.createElement('div');
    const marker = document.createElement('span');

    marker.textContent = '.';
    element.style.setProperty('position', 'fixed');
    element.style.setProperty('height', 'auto');
    element.style.setProperty('overflow', 'hidden');
    element.style.setProperty('visibility', 'hidden');
    element.style.setProperty('pointer-events', 'none');
    element.appendChild(marker);
    document.body.appendChild(element);
    caretMirror = { element, marker };

    return caretMirror;
}

// The caret's distance from the left edge of the text box, border and padding included. Only the text of the caret's own
// line is laid out: the lines above it do not change where the caret sits on its line.
function measureCaretLeftInBox(textBox: HTMLTextAreaElement | HTMLInputElement, boxRect: CaretBox, textOnCaretLine: string): number {
    const mirror = getCaretMirror();
    const computed = window.getComputedStyle(textBox);

    MIRRORED_PROPERTIES.forEach((property) => {
        const propertyValue = computed.getPropertyValue(property);

        mirror.element.style.setProperty(property, propertyValue);
    });

    const paddingLeftValue = computed.getPropertyValue('padding-left');
    const paddingRightValue = computed.getPropertyValue('padding-right');
    const paddingLeft = readPixels(paddingLeftValue);
    const paddingRight = readPixels(paddingRightValue);
    const contentWidth = Math.max(0, textBox.clientWidth - paddingLeft - paddingRight);
    const widthPixels = `${String(contentWidth)}px`;
    const leftPixels = `${String(boxRect.left)}px`;
    const topPixels = `${String(boxRect.top)}px`;

    mirror.element.style.setProperty('box-sizing', 'content-box');
    mirror.element.style.setProperty('width', widthPixels);
    mirror.element.style.setProperty('left', leftPixels);
    mirror.element.style.setProperty('top', topPixels);
    mirror.element.textContent = textOnCaretLine;
    mirror.element.appendChild(mirror.marker);

    const mirrorRect = mirror.element.getBoundingClientRect();
    const markerRect = mirror.marker.getBoundingClientRect();

    return markerRect.left - mirrorRect.left - textBox.scrollLeft;
}

// A CSS length in pixels. Zero when the browser gives no usable value.
function readPixels(cssValue: string): number {
    const parsed = parseFloat(cssValue);

    return Number.isFinite(parsed) ? parsed : 0;
}

// Keeps a number between zero and one.
function clampUnit(value: number): number {
    const atLeastZero = Math.max(0, value);

    return Math.min(1, atLeastZero);
}

// The last measure. A typing change that leaves the value, the caret and the width alone reuses its fraction.
interface CaretMeasure {
    element: HTMLTextAreaElement | HTMLInputElement;
    value: string;
    caretIndex: number;
    width: number;
    fraction: number;
}

let lastMeasure: CaretMeasure | undefined;

// Where the caret sits along the text box the owner is typing in: 0 at its left edge, 1 at its right edge.
// Undefined when no text box has the focus. Half when the box has no width.
function getCaretFraction(): number | undefined {
    const focused = document.activeElement;
    const isTextBox = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement;

    if (!isTextBox) {
        return undefined;
    }

    const boxRect = focused.getBoundingClientRect();

    if (boxRect.width <= 0) {
        return 0.5;
    }

    const value = focused.value;
    const caretIndex = focused.selectionStart ?? value.length;

    if (
        lastMeasure !== undefined
        && lastMeasure.element === focused
        && lastMeasure.value === value
        && lastMeasure.caretIndex === caretIndex
        && lastMeasure.width === boxRect.width
    ) {
        return lastMeasure.fraction;
    }

    const lineStart = value.lastIndexOf('\n', caretIndex - 1) + 1;
    const textOnCaretLine = value.slice(lineStart, caretIndex);
    const caretLeftInBox = measureCaretLeftInBox(focused, boxRect, textOnCaretLine);
    const fraction = clampUnit(caretLeftInBox / boxRect.width);

    lastMeasure = { element: focused, value, caretIndex, width: boxRect.width, fraction };

    return fraction;
}

// The eye offset while typing. The caret at the left edge turns the eyes to -maxOffset, at the right edge to +maxOffset,
// and the eyes look down at the box by lookDownOffset.
function computeTypingEyeOffset(caretFraction: number, maxOffset: number, lookDownOffset: number): Point {
    const sideways = (caretFraction * 2 - 1) * maxOffset;

    return { x: sideways, y: lookDownOffset };
}

// The typing listeners follow the caret. They share one pair of document listeners. Each typing change is measured
// at once, not in an animation frame: a frame that never runs (a hidden or stalled tab) would stop every later update.
type CaretFractionListener = (caretFraction: number) => void;

const typingListeners = new Set<CaretFractionListener>();

function notifyTypingListeners(): void {
    const caretFraction = getCaretFraction();

    if (caretFraction === undefined) {
        return;
    }

    typingListeners.forEach((listener) => {
        listener(caretFraction);
    });
}

// Calls the new listener with the caret position now, and every listener again after each typing change or caret move.
// Returns a function that stops the listener.
function subscribeToTyping(listener: CaretFractionListener): () => void {
    if (typingListeners.size === 0) {
        document.addEventListener('input', notifyTypingListeners);
        document.addEventListener('selectionchange', notifyTypingListeners);
    }

    typingListeners.add(listener);

    const caretFraction = getCaretFraction();

    if (caretFraction !== undefined) {
        listener(caretFraction);
    }

    return () => {
        typingListeners.delete(listener);

        if (typingListeners.size > 0) {
            return;
        }

        document.removeEventListener('input', notifyTypingListeners);
        document.removeEventListener('selectionchange', notifyTypingListeners);
    };
}

export { computeEyeOffset, computeTypingEyeOffset, getCaretFraction, subscribeToPointer, subscribeToTyping };
export type { CaretFractionListener, Point, PointListener };
