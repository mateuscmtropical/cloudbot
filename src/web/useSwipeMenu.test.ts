import { describe, expect, it } from 'vitest';

import { readSwipe } from './useSwipeMenu.ts';

describe('readSwipe', () => {
    it('reads a long horizontal drag to the right and to the left', () => {
        expect(readSwipe({ x: 20, y: 300 }, { x: 160, y: 310 }))
            .toBe('right');
        expect(readSwipe({ x: 200, y: 300 }, { x: 60, y: 290 }))
            .toBe('left');
    });

    it('ignores a short drag', () => {
        expect(readSwipe({ x: 20, y: 300 }, { x: 60, y: 300 }))
            .toBeUndefined();
    });

    it('ignores a drag that is mostly vertical or diagonal', () => {
        expect(readSwipe({ x: 20, y: 100 }, { x: 100, y: 400 }))
            .toBeUndefined();
        expect(readSwipe({ x: 20, y: 100 }, { x: 120, y: 200 }))
            .toBeUndefined();
    });
});
