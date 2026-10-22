import type { RoutineSchedule } from '../shared/routineTypes.ts';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function padTwoDigits(value: number): string {
    return String(value)
        .padStart(2, '0');
}

function formatTimeOfDay(hour: number, minute: number): string {
    return `${padTwoDigits(hour)}:${padTwoDigits(minute)} UTC`;
}

// Times are UTC, so the text says so.
function describeSchedule(schedule: RoutineSchedule): string {
    if (schedule.kind === 'once') {
        return `Once at ${formatRunTime(schedule.at)}`;
    }

    if (schedule.kind === 'interval') {
        return `Every ${String(schedule.everyMinutes)} minutes`;
    }

    const timeText = formatTimeOfDay(schedule.hour, schedule.minute);

    if (schedule.kind === 'daily') {
        return `Every day at ${timeText}`;
    }

    // The server only stores weekdays 0 to 6, so the fallback is never shown.
    const weekdayName = WEEKDAY_NAMES[schedule.weekday] ?? 'unknown day';

    return `Every ${weekdayName} at ${timeText}`;
}

// Shows a run time in UTC, or "never" when the routine has not run yet.
function formatRunTime(runAtMs: number | null): string {
    if (runAtMs === null) {
        return 'never';
    }

    const isoText = new Date(runAtMs)
        .toISOString();

    return `${isoText.slice(0, 10)} ${isoText.slice(11, 16)} UTC`;
}

export { describeSchedule, formatRunTime };
