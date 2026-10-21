// A turn that sends no agent event for this long is stalled. The owner reads the message in the chat.
const STALL_MS = 10 * 60 * 1000;
const STALL_MESSAGE = 'The turn stopped because it sent nothing for 10 minutes.';

// Fires once when a running turn sends no agent event for STALL_MS. Time the owner is asked does not count.
// The timer starts again on each event, and when the owner's wait ends. Waits nest, like the turn clock.
class StallWatchdog {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private openWaits = 0;
    private isStopped = false;
    private readonly onStall: () => void;

    constructor(onStall: () => void) {
        this.onStall = onStall;
    }

    start(): void {
        this.touch();
    }

    // Every agent event of the turn counts as activity.
    touch(): void {
        this.clear();

        if (this.isStopped || this.openWaits > 0) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.isStopped = true;
            this.onStall();
        }, STALL_MS);
    }

    setWaitingOnOwner(isWaiting: boolean): void {
        if (this.isStopped) {
            return;
        }

        if (isWaiting) {
            this.openWaits += 1;
            this.clear();

            return;
        }

        if (this.openWaits > 0) {
            this.openWaits -= 1;
        }

        this.touch();
    }

    stop(): void {
        this.isStopped = true;
        this.clear();
    }

    private clear(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}

export { STALL_MESSAGE, STALL_MS, StallWatchdog };
