import { describe, expect, it } from 'vitest';

import { cursorSteps, pressHoldMs } from './humanCursor.ts';

describe('cursorSteps', () => {
    it('moves along many points from the start to the end, with waits that add up to a hand move', () => {
        const steps = cursorSteps({ x: 10, y: 10 }, { x: 500, y: 300 });
        const totalMs = steps.reduce((sum, step) => sum + step.waitMs, 0);
        const last = steps.at(-1);

        expect(steps.length)
            .toBeGreaterThan(5);
        expect(last)
            .toMatchObject({ x: 500, y: 300 });
        expect(steps.every(step => step.x >= 0 && step.y >= 0 && step.waitMs >= 0))
            .toBe(true);
        expect(totalMs)
            .toBeGreaterThan(100);
        expect(totalMs)
            .toBeLessThan(5000);
    });
});

describe('pressHoldMs', () => {
    it('holds the button between 50 and 120 ms', () => {
        expect([pressHoldMs(() => 0), pressHoldMs(() => 1)])
            .toEqual([50, 120]);
    });
});
