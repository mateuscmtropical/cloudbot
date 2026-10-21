// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeEyeOffset, subscribeToPointer } from './mascotPointer.ts';
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
