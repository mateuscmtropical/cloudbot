import { describe, expect, it } from 'vitest';

import { isQuietReply } from './checkin.ts';

describe('isQuietReply', () => {
    it('accepts the quiet reply with small formatting changes', () => {
        expect(isQuietReply('NOTHING_TO_REPORT'))
            .toBe(true);
        expect(isQuietReply('  NOTHING_TO_REPORT\n'))
            .toBe(true);
        expect(isQuietReply('`NOTHING_TO_REPORT`.'))
            .toBe(true);
    });

    it('refuses a reply that says more than the quiet reply', () => {
        expect(isQuietReply('Nothing new in your inbox.'))
            .toBe(false);
        expect(isQuietReply('NOTHING_TO_REPORT, but your invoice is due.'))
            .toBe(false);
        expect(isQuietReply(''))
            .toBe(false);
    });
});
