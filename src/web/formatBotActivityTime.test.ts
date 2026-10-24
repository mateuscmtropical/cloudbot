import { describe, expect, it } from 'vitest';

import { formatBotActivityTime } from './formatBotActivityTime.ts';

describe('formatBotActivityTime', () => {
    it('shows a 24-hour time for activity today', () => {
        const now = new Date(2026, 9, 23, 23, 44);
        const timestamp = new Date(2026, 9, 23, 16, 0)
            .getTime();

        expect(formatBotActivityTime(timestamp, now, 'en-GB'))
            .toBe('16:00');
    });

    it('shows the localized weekday for activity within the last week', () => {
        const now = new Date(2026, 9, 23, 12, 0);
        const timestamp = new Date(2026, 9, 21, 16, 0)
            .getTime();

        expect(formatBotActivityTime(timestamp, now, 'en-GB'))
            .toBe('Wednesday');
    });

    it('shows the localized short date for older activity', () => {
        const now = new Date(2026, 9, 23, 12, 0);
        const timestamp = new Date(2026, 9, 10, 16, 0)
            .getTime();

        expect(formatBotActivityTime(timestamp, now, 'en-GB'))
            .toBe('10/10/2026');
    });

    it('shows a date for activity exactly one week ago', () => {
        const now = new Date(2026, 9, 23, 12, 0);
        const timestamp = new Date(2026, 9, 16, 12, 0)
            .getTime();

        expect(formatBotActivityTime(timestamp, now, 'en-GB'))
            .toBe('16/10/2026');
    });

    it('returns no label when a bot has no activity', () => {
        expect(formatBotActivityTime(undefined))
            .toBe('');
    });
});
