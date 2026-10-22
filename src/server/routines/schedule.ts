type RoutineSchedule
    = | { kind: 'interval'; everyMinutes: number }
        | { kind: 'daily'; hour: number; minute: number }
        | { kind: 'weekly'; weekday: number; hour: number; minute: number }
        | { kind: 'once'; at: number };

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// Returns undefined for anything that is not a valid schedule. Times are UTC.
function parseSchedule(input: unknown): RoutineSchedule | undefined {
    if (typeof input !== 'object' || input === null) {
        return undefined;
    }

    const candidate = input as Record<string, unknown>;
    const { hour, minute } = candidate;

    if (candidate['kind'] === 'once') {
        const { at } = candidate;

        return isIntegerInRange(at, 1, Number.MAX_SAFE_INTEGER) ? { kind: 'once', at } : undefined;
    }

    if (candidate['kind'] === 'interval') {
        const { everyMinutes } = candidate;

        return isIntegerInRange(everyMinutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)
            ? { kind: 'interval', everyMinutes }
            : undefined;
    }

    if (!isIntegerInRange(hour, 0, 23) || !isIntegerInRange(minute, 0, 59)) {
        return undefined;
    }

    if (candidate['kind'] === 'daily') {
        return { kind: 'daily', hour, minute };
    }

    const { weekday } = candidate;

    if (candidate['kind'] === 'weekly' && isIntegerInRange(weekday, 0, 6)) {
        return { kind: 'weekly', weekday, hour, minute };
    }

    return undefined;
}

// The first run strictly after `afterMs`. Weekdays count from Sunday as 0, like Date.getUTCDay.
// A once routine has one run, so its time stays as it is. The store turns it off after that run.
function computeNextRun(schedule: RoutineSchedule, afterMs: number): number {
    if (schedule.kind === 'once') {
        return schedule.at;
    }

    if (schedule.kind === 'interval') {
        return afterMs + schedule.everyMinutes * MINUTE_MS;
    }

    const startOfDay = Math.floor(afterMs / DAY_MS) * DAY_MS;
    const timeOfDayMs = (schedule.hour * 60 + schedule.minute) * MINUTE_MS;
    const todayRun = startOfDay + timeOfDayMs;
    const nextDayRun = todayRun > afterMs ? todayRun : todayRun + DAY_MS;

    if (schedule.kind === 'daily') {
        return nextDayRun;
    }

    const nextDayWeekday = new Date(nextDayRun)
        .getUTCDay();
    const daysToWait = (schedule.weekday - nextDayWeekday + 7) % 7;

    return nextDayRun + daysToWait * DAY_MS;
}

export { computeNextRun, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, parseSchedule };
export type { RoutineSchedule };
