// Based on RoomTurnDeadline from OpenMausBot (https://github.com/milind-soni/OpenMausBot), Apache License 2.0.
// Changed for CloudBot: renamed, takes milliseconds, and follows the CloudBot code style. See NOTICE.
// Counts work, not wall time: the clock holds while the turn waits on the owner. It fires once.
class TurnDeadline {
    private remainingMs: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private openRequests = 0;
    private isStopped = false;
    private isFired = false;
    private armedAt = 0;
    private readonly onExpire: () => void;

    constructor(durationMs: number, onExpire: () => void) {
        this.remainingMs = durationMs;
        this.onExpire = onExpire;
    }

    start(): void {
        this.arm();
    }

    // Calls nest. The clock runs again only when every wait has ended.
    setWaitingOnHuman(isWaiting: boolean): void {
        if (this.isStopped || this.isFired) {
            return;
        }

        if (isWaiting) {
            const wasIdle = this.openRequests === 0;

            this.openRequests += 1;

            if (wasIdle) {
                this.hold();
            }

            return;
        }

        if (this.openRequests > 0) {
            this.openRequests -= 1;

            if (this.openRequests === 0) {
                this.arm();
            }
        }
    }

    // The turn ended in time. No further expiry fires.
    stop(): void {
        this.isStopped = true;
        this.clearTimer();
    }

    private hold(): void {
        if (this.timer === null) {
            return;
        }

        this.remainingMs -= Date.now() - this.armedAt;
        this.clearTimer();

        // A delayed event loop can deliver the wait after the deadline. A person's wait must not extend an exhausted budget.
        if (this.remainingMs <= 0) {
            this.expire();
        }
    }

    private arm(): void {
        if (this.isStopped || this.isFired || this.openRequests > 0) {
            return;
        }

        if (this.remainingMs <= 0) {
            this.expire();

            return;
        }

        this.armedAt = Date.now();
        this.timer = setTimeout(() => {
            this.timer = null;
            this.expire();
        }, this.remainingMs);
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private expire(): void {
        if (this.isStopped || this.isFired) {
            return;
        }

        this.isFired = true;
        this.onExpire();
    }
}

export { TurnDeadline };
