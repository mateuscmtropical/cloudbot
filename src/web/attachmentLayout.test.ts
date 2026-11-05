import { describe, expect, it } from 'vitest';

import { mosaicSpan, singleImageRatio, swipeStep } from './attachmentLayout.ts';

function spans(count: number): number[] {
    const indexes = Array.from({ length: count }, (_unused, index) => index);

    return indexes.map(index => mosaicSpan(index, count));
}

describe('mosaicSpan', () => {
    it('fills every row for any number of images', () => {
        expect(spans(2))
            .toEqual([3, 3]);
        expect(spans(3))
            .toEqual([2, 2, 2]);
        expect(spans(4))
            .toEqual([6, 2, 2, 2]);
        expect(spans(5))
            .toEqual([3, 3, 2, 2, 2]);
        expect(spans(10)
            .reduce((sum, span) => sum + span, 0) % 6)
            .toBe(0);
    });
});

describe('singleImageRatio', () => {
    it('uses the image size, keeps extremes in a box and has a default', () => {
        expect(singleImageRatio(1600, 900))
            .toBeCloseTo(16 / 9);
        expect(singleImageRatio(100, 5000))
            .toBe(0.5);
        expect(singleImageRatio(undefined, undefined))
            .toBeCloseTo(4 / 3);
        expect(singleImageRatio(0, 0))
            .toBeCloseTo(4 / 3);
    });
});

describe('swipeStep', () => {
    it('goes forward on a left swipe, back on a right swipe, and ignores small or vertical moves', () => {
        expect(swipeStep(-80, 10))
            .toBe(1);
        expect(swipeStep(80, 10))
            .toBe(-1);
        expect(swipeStep(-20, 0))
            .toBe(0);
        expect(swipeStep(-80, 200))
            .toBe(0);
    });
});
