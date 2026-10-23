import { describe, expect, it } from 'vitest';

import { DOUBLE_TAP_MS, nextTap } from './doubleTap.ts';

describe('nextTap', () => {
    it('remembers the first tap', () => {
        expect(nextTap(undefined, 'bot-1', 1000))
            .toEqual({ tap: { id: 'bot-1', at: 1000 }, isDouble: false });
    });

    it('sees a second tap on the same thing in time as a double tap, and forgets it', () => {
        const first = nextTap(undefined, 'bot-1', 1000);

        expect(nextTap(first.tap, 'bot-1', 1000 + DOUBLE_TAP_MS))
            .toEqual({ tap: undefined, isDouble: true });
    });

    it('starts over when the second tap is late or on another thing', () => {
        const first = nextTap(undefined, 'bot-1', 1000);

        expect(nextTap(first.tap, 'bot-1', 1001 + DOUBLE_TAP_MS))
            .toEqual({ tap: { id: 'bot-1', at: 1001 + DOUBLE_TAP_MS }, isDouble: false });
        expect(nextTap(first.tap, 'bot-2', 1100))
            .toEqual({ tap: { id: 'bot-2', at: 1100 }, isDouble: false });
    });

    it('does not count a third tap as another double tap', () => {
        const first = nextTap(undefined, 'bot-1', 1000);
        const second = nextTap(first.tap, 'bot-1', 1100);

        expect(nextTap(second.tap, 'bot-1', 1200).isDouble)
            .toBe(false);
    });
});
