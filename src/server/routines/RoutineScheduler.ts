import type { RoutineRecord, RoutineStore } from '../store/RoutineStore.ts';

interface RoutineSchedulerOptions {
    routineStore: RoutineStore;
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    // Routines wait while this returns false. ChatService answers a message with a reminder until Claude setup is done.
    isReady?: () => boolean;
    now?: () => number;
}

const CHECK_INTERVAL_MS = 30 * 1000;

function buildRoutineMessage(routine: RoutineRecord): string {
    return `Routine "${routine.name}": ${routine.prompt}`;
}

// Sends the prompt of each due routine to its bot as a normal chat message,
// so the turn queue, usage waits and approvals apply as for any message.
class RoutineScheduler {
    private readonly routineStore: RoutineStore;
    private readonly sendMessage: (botId: string, text: string) => Promise<unknown>;
    private readonly isReady: () => boolean;
    private readonly now: () => number;
    private timer: NodeJS.Timeout | undefined;
    private isChecking = false;

    constructor(options: RoutineSchedulerOptions) {
        this.routineStore = options.routineStore;
        this.sendMessage = options.sendMessage;
        this.isReady = options.isReady ?? (() => true);
        this.now = options.now ?? (() => Date.now());
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }

        const runCheck = (): void => {
            this.checkDueRoutines()
                .catch(() => {
                    console.error('Could not check the routines.');
                });
        };

        this.timer = setInterval(runCheck, CHECK_INTERVAL_MS);
        this.timer.unref();
        runCheck();
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    // A routine that was due while the server was off runs once. The next run moves
    // forward before the message is sent, so a crash in between cannot repeat it.
    async checkDueRoutines(): Promise<void> {
        if (this.isChecking || !this.isReady()) {
            return;
        }

        this.isChecking = true;

        try {
            const nowMs = this.now();
            const dueRoutines = await this.routineStore.listDue(nowMs);
            const runRoutines = dueRoutines.map(routine => this.runRoutine(routine, nowMs));

            await Promise.all(runRoutines);
        } finally {
            this.isChecking = false;
        }
    }

    private async runRoutine(routine: RoutineRecord, nowMs: number): Promise<void> {
        try {
            await this.routineStore.markRun(routine, nowMs);

            const message = buildRoutineMessage(routine);

            await this.sendMessage(routine.botId, message);
        } catch {
            // One failing routine must not stop the others. The log names the routine, not its prompt.
            console.error(`Could not run the routine ${routine.id}.`);
        }
    }
}

export { buildRoutineMessage, CHECK_INTERVAL_MS, RoutineScheduler };
export type { RoutineSchedulerOptions };
