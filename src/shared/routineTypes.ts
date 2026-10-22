// Times are UTC. Weekdays count from Sunday as 0, like Date.getUTCDay.
type RoutineSchedule
    = | { kind: 'interval'; everyMinutes: number }
        | { kind: 'daily'; hour: number; minute: number }
        | { kind: 'weekly'; weekday: number; hour: number; minute: number }
        | { kind: 'once'; at: number };

// A routine as the API shows it. Times are milliseconds since the epoch.
interface BotRoutine {
    id: string;
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
    isEnabled: boolean;
    // A check-in messages the owner only when something needs them.
    isQuiet: boolean;
    nextRunAt: number;
    lastRunAt: number | null;
}

export type { BotRoutine, RoutineSchedule };
