import { describe, expect, it } from 'vitest';

import { DEFAULT_DESKTOP_SIZE, isValidDesktopSize } from './desktopSize.ts';

describe('isValidDesktopSize', () => {
    it('accepts the default desktop size and a bounded phone size', () => {
        expect(isValidDesktopSize(DEFAULT_DESKTOP_SIZE.width, DEFAULT_DESKTOP_SIZE.height))
            .toBe(true);
        expect(isValidDesktopSize(400, 800))
            .toBe(true);
    });

    it('rejects dimensions below the minimum or above the maximum', () => {
        expect(isValidDesktopSize(239, 800))
            .toBe(false);
        expect(isValidDesktopSize(1280, 1921))
            .toBe(false);
    });

    it('rejects fractional dimensions', () => {
        expect(isValidDesktopSize(400.5, 800))
            .toBe(false);
    });
});
