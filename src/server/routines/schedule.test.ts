import { describe, expect, it } from 'vitest';

import { computeNextRun, parseSchedule } from './schedule.ts';

// Wednesday 2026-10-21 11:08 UTC.
const WEDNESDAY_NOON = Date.UTC(2026, 9, 21, 11, 8);

describe('computeNextRun', () => {
    it('adds the interval', () => {
        expect(computeNextRun({ kind: 'interval', everyMinutes: 30 }, WEDNESDAY_NOON))
            .toBe(WEDNESDAY_NOON + 30 * 60 * 1000);
    });

    it('picks later today for a daily time that has not passed', () => {
        expect(computeNextRun({ kind: 'daily', hour: 18, minute: 30 }, WEDNESDAY_NOON))
            .toBe(Date.UTC(2026, 9, 21, 18, 30));
    });

    it('picks tomorrow for a daily time that has passed', () => {
        expect(computeNextRun({ kind: 'daily', hour: 8, minute: 0 }, WEDNESDAY_NOON))
            .toBe(Date.UTC(2026, 9, 22, 8, 0));
    });

    it('never returns the instant it is given', () => {
        const exact = Date.UTC(2026, 9, 21, 8, 0);

        expect(computeNextRun({ kind: 'daily', hour: 8, minute: 0 }, exact))
            .toBe(Date.UTC(2026, 9, 22, 8, 0));
    });

    it('finds the next matching weekday', () => {
        // Friday is 5.
        expect(computeNextRun({ kind: 'weekly', weekday: 5, hour: 9, minute: 15 }, WEDNESDAY_NOON))
            .toBe(Date.UTC(2026, 9, 23, 9, 15));
    });

    it('waits a week when the weekday time has passed today', () => {
        expect(computeNextRun({ kind: 'weekly', weekday: 3, hour: 8, minute: 0 }, WEDNESDAY_NOON))
            .toBe(Date.UTC(2026, 9, 28, 8, 0));
    });

    it('runs later today on the matching weekday', () => {
        expect(computeNextRun({ kind: 'weekly', weekday: 3, hour: 20, minute: 0 }, WEDNESDAY_NOON))
            .toBe(Date.UTC(2026, 9, 21, 20, 0));
    });

    it('crosses a month end', () => {
        const lastDay = Date.UTC(2026, 9, 31, 23, 0);

        expect(computeNextRun({ kind: 'daily', hour: 1, minute: 0 }, lastDay))
            .toBe(Date.UTC(2026, 10, 1, 1, 0));
    });
});

describe('parseSchedule', () => {
    it('accepts the three kinds', () => {
        expect(parseSchedule({ kind: 'interval', everyMinutes: 5 }))
            .toEqual({ kind: 'interval', everyMinutes: 5 });
        expect(parseSchedule({ kind: 'daily', hour: 23, minute: 59 }))
            .toEqual({ kind: 'daily', hour: 23, minute: 59 });
        expect(parseSchedule({ kind: 'weekly', weekday: 0, hour: 0, minute: 0, extra: 1 }))
            .toEqual({ kind: 'weekly', weekday: 0, hour: 0, minute: 0 });
        expect(parseSchedule({ kind: 'once', at: 1_800_000_000_000 }))
            .toEqual({ kind: 'once', at: 1_800_000_000_000 });
    });

    it('keeps the time of a once routine as its next run', () => {
        expect(computeNextRun({ kind: 'once', at: 1_800_000_000_000 }, 1_900_000_000_000))
            .toBe(1_800_000_000_000);
    });

    it.each([
        null,
        'daily',
        {},
        { kind: 'interval', everyMinutes: 4 },
        { kind: 'interval', everyMinutes: 10081 },
        { kind: 'interval', everyMinutes: 7.5 },
        { kind: 'interval', everyMinutes: '10' },
        { kind: 'daily', hour: 24, minute: 0 },
        { kind: 'daily', hour: 8 },
        { kind: 'weekly', weekday: 7, hour: 8, minute: 0 },
        { kind: 'weekly', hour: 8, minute: 0 },
        { kind: 'monthly', hour: 8, minute: 0 },
        { kind: 'once' },
        { kind: 'once', at: Number.NaN },
        { kind: 'once', at: '2026-01-31T18:30:00Z' },
    ])('refuses %j', (input) => {
        expect(parseSchedule(input))
            .toBeUndefined();
    });
});
