// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeEyeOffset, computeTypingEyeOffset, getCaretFraction, subscribeToPointer, subscribeToTyping } from './mascotPointer.ts';
import type { Point } from './mascotPointer.ts';

const ORIGIN: Point = { x: 100, y: 100 };
const MAX_OFFSET = 2.5;

describe('computeEyeOffset', () => {
    it('does not move the eyes when the pointer is on the face', () => {
        expect(computeEyeOffset(ORIGIN, ORIGIN, MAX_OFFSET))
            .toEqual({ x: 0, y: 0 });
    });

    it('points the eyes toward the pointer', () => {
        const offset = computeEyeOffset(ORIGIN, { x: 110, y: 100 }, MAX_OFFSET);

        expect(offset.x)
            .toBeGreaterThan(0);
        expect(offset.y)
            .toBeCloseTo(0);
    });

    it('moves the eyes less for a closer pointer, in proportion to the distance', () => {
        const near = computeEyeOffset(ORIGIN, { x: 130, y: 100 }, MAX_OFFSET);
        const nearer = computeEyeOffset(ORIGIN, { x: 115, y: 100 }, MAX_OFFSET);

        expect(nearer.x)
            .toBeCloseTo(near.x / 2);
    });

    it('caps the offset at the maximum for a far pointer', () => {
        const offset = computeEyeOffset(ORIGIN, { x: 1000, y: 100 }, MAX_OFFSET);

        expect(offset.x)
            .toBeCloseTo(MAX_OFFSET);
        expect(offset.y)
            .toBeCloseTo(0);
    });

    it('keeps the length of the offset under the maximum in every direction', () => {
        const offset = computeEyeOffset(ORIGIN, { x: 300, y: -40 }, MAX_OFFSET);
        const length = Math.hypot(offset.x, offset.y);

        expect(length)
            .toBeLessThanOrEqual(MAX_OFFSET + 1e-9);
    });
});

describe('subscribeToPointer', () => {
    let stopListening: (() => void) | undefined;

    afterEach(() => {
        stopListening?.();
        stopListening = undefined;
        vi.restoreAllMocks();
    });

    it('adds one pair of window listeners for any number of mascots, and removes them when the last one stops', () => {
        const addSpy = vi.spyOn(window, 'addEventListener');
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const stopFirst = subscribeToPointer(() => undefined);
        const stopSecond = subscribeToPointer(() => undefined);
        const pointerAdds = addSpy.mock.calls.filter(call => call[0] === 'pointermove' || call[0] === 'pointerdown');

        expect(pointerAdds)
            .toHaveLength(2);

        stopFirst();
        stopSecond();

        const pointerRemoves = removeSpy.mock.calls.filter(call => call[0] === 'pointermove' || call[0] === 'pointerdown');

        expect(pointerRemoves)
            .toHaveLength(2);
    });

    it('batches pointer moves into one call per animation frame, with the latest point', () => {
        const frames: FrameRequestCallback[] = [];

        vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation((callback) => {
                frames.push(callback);

                return frames.length;
            });
        vi.spyOn(window, 'cancelAnimationFrame')
            .mockImplementation(() => undefined);

        const listener = vi.fn<(point: Point) => void>();

        stopListening = subscribeToPointer(listener);

        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 20 }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 40 }));

        expect(frames)
            .toHaveLength(1);
        expect(listener)
            .not.toHaveBeenCalled();

        frames.forEach((callback) => {
            callback(0);
        });

        expect(listener)
            .toHaveBeenCalledTimes(1);
        expect(listener)
            .toHaveBeenCalledWith({ x: 30, y: 40 });
    });

    it('treats a tap as a pointer point too, so touch screens move the eyes', () => {
        const frames: FrameRequestCallback[] = [];

        vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation((callback) => {
                frames.push(callback);

                return frames.length;
            });
        vi.spyOn(window, 'cancelAnimationFrame')
            .mockImplementation(() => undefined);

        const listener = vi.fn<(point: Point) => void>();

        stopListening = subscribeToPointer(listener);

        window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 5, clientY: 6 }));
        frames.forEach((callback) => {
            callback(0);
        });

        expect(listener)
            .toHaveBeenCalledWith({ x: 5, y: 6 });
    });
});

const CARET_BOX_RECT = { left: 100, top: 300, width: 200, height: 40, right: 300, bottom: 340, x: 100, y: 300, toJSON: () => ({}) };

describe('computeTypingEyeOffset', () => {
    it('turns the eyes to the left at the left edge of the text box, and to the right at the right edge', () => {
        expect(computeTypingEyeOffset(0, 3, 2))
            .toEqual({ x: -3, y: 2 });
        expect(computeTypingEyeOffset(1, 3, 2))
            .toEqual({ x: 3, y: 2 });
    });

    it('looks straight down the middle of the text box, linearly in between', () => {
        expect(computeTypingEyeOffset(0.5, 3, 2))
            .toEqual({ x: 0, y: 2 });
        expect(computeTypingEyeOffset(0.25, 3, 2).x)
            .toBeCloseTo(-1.5);
    });
});

describe('getCaretFraction', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('has no fraction when no text box has the focus', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea><button id="other">Other</button>';
        const otherButton = document.getElementById('other');

        otherButton?.focus();

        expect(getCaretFraction())
            .toBeUndefined();
    });

    it('reads a fraction between zero and one', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        textarea.focus();

        // Happy-dom has no layout, so the caret reads at the left edge here. Real positions are checked in a browser.
        const fraction = getCaretFraction();

        expect(fraction)
            .toBeGreaterThanOrEqual(0);
        expect(fraction)
            .toBeLessThanOrEqual(1);
    });

    it('keeps one hidden mirror in the page, with the padding of the text box and the text before the caret', () => {
        document.body.innerHTML = '<textarea id="composer" style="padding: 0 12px; border: 1px solid #000"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        textarea.value = 'hello world';
        textarea.setSelectionRange(5, 5);
        textarea.focus();

        getCaretFraction();
        getCaretFraction();

        const mirrors = document.body.querySelectorAll('div');
        const mirror = mirrors[0];

        expect(mirrors)
            .toHaveLength(1);
        expect(mirror?.style.getPropertyValue('padding-left'))
            .toBe('12px');
        expect(mirror?.style.getPropertyValue('visibility'))
            .toBe('hidden');
        expect(mirror?.textContent)
            .toBe('hello.');
    });

    it('does not measure again when the value, the caret and the width are unchanged', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        const markerSpy = vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect');

        textarea.value = 'hello';
        textarea.setSelectionRange(5, 5);
        textarea.focus();

        getCaretFraction();
        getCaretFraction();

        expect(markerSpy)
            .toHaveBeenCalledTimes(1);

        textarea.value = 'hello!';
        textarea.setSelectionRange(6, 6);
        getCaretFraction();

        expect(markerSpy)
            .toHaveBeenCalledTimes(2);
    });
});

// A marker sits after the typed text in the mirror. Seven pixels per character puts it where a 16 px font would.
function mockTypedTextWidth(): void {
    vi.spyOn(HTMLSpanElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function markerRect(this: HTMLSpanElement) {
            const typedLength = (this.parentElement?.textContent ?? '').length - 1;
            const left = typedLength * 7;

            return { left, top: 0, right: left, bottom: 0, x: left, y: 0, width: 0, height: 0, toJSON: () => ({}) };
        });
}

describe('subscribeToTyping', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    it('moves the caret fraction as the owner types several characters', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        mockTypedTextWidth();
        textarea.focus();

        const listener = vi.fn<(caretFraction: number) => void>();
        const stopListening = subscribeToTyping(listener);

        ['a', 'b', 'c', 'd'].forEach((character) => {
            textarea.value = `${textarea.value}${character}`;
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const fractions = listener.mock.calls.map(call => call[0]);

        expect(fractions)
            .toHaveLength(5);
        const laterFractions = fractions.slice(1);

        laterFractions.forEach((fraction, index) => {
            expect(fraction)
                .toBeGreaterThan(fractions[index] ?? -1);
        });

        stopListening();
    });

    it('keeps updating when animation frames never run, such as in a stalled tab', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        vi.spyOn(window, 'requestAnimationFrame')
            .mockImplementation(() => 1);
        mockTypedTextWidth();
        textarea.focus();

        const listener = vi.fn<(caretFraction: number) => void>();
        const stopListening = subscribeToTyping(listener);

        textarea.value = 'hello';
        textarea.setSelectionRange(5, 5);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.value = 'hello world';
        textarea.setSelectionRange(11, 11);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        expect(listener)
            .toHaveBeenCalledTimes(3);

        stopListening();
    });

    it('stops calling the listener once it is unsubscribed', () => {
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue(CARET_BOX_RECT);
        textarea.focus();

        const listener = vi.fn<(caretFraction: number) => void>();
        const stopListening = subscribeToTyping(listener);

        stopListening();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        expect(listener)
            .toHaveBeenCalledTimes(1);
    });
});
