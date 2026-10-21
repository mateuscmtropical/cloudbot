import { describe, expect, it } from 'vitest';

import { describeSchedule, formatRunTime } from './routineText.ts';

describe('describeSchedule', () => {
    it('says how many minutes an interval waits', () => {
        expect(describeSchedule({ kind: 'interval', everyMinutes: 90 }))
            .toBe('Every 90 minutes');
    });

    it('says the UTC time of a daily routine with two digit parts', () => {
        expect(describeSchedule({ kind: 'daily', hour: 9, minute: 5 }))
            .toBe('Every day at 09:05 UTC');
    });

    it('names the weekday of a weekly routine', () => {
        expect(describeSchedule({ kind: 'weekly', weekday: 1, hour: 9, minute: 5 }))
            .toBe('Every Monday at 09:05 UTC');
    });
});

describe('formatRunTime', () => {
    it('shows a run time in UTC', () => {
        expect(formatRunTime(Date.UTC(2026, 9, 21, 9, 5)))
            .toBe('2026-10-21 09:05 UTC');
    });

    it('shows never for a routine that has not run', () => {
        expect(formatRunTime(null))
            .toBe('never');
    });
});
