import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STALL_MS, StallWatchdog } from './StallWatchdog.ts';

const MINUTE_MS = 60_000;

describe('StallWatchdog', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires once after 10 minutes with no event', async () => {
        const onStall = vi.fn();
        const watch = new StallWatchdog(onStall);

        watch.start();
        await vi.advanceTimersByTimeAsync(STALL_MS - 1);

        expect(onStall)
            .not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(STALL_MS);

        expect(onStall)
            .toHaveBeenCalledTimes(1);
    });

    it('starts the count again on each event', async () => {
        const onStall = vi.fn();
        const watch = new StallWatchdog(onStall);

        watch.start();
        await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);
        watch.touch();
        await vi.advanceTimersByTimeAsync(9 * MINUTE_MS);

        expect(onStall)
            .not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(onStall)
            .toHaveBeenCalledTimes(1);
    });

    it('does not count the time the owner is asked, and counts again after the answer', async () => {
        const onStall = vi.fn();
        const watch = new StallWatchdog(onStall);

        watch.start();
        watch.setWaitingOnOwner(true);
        await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

        expect(onStall)
            .not.toHaveBeenCalled();

        watch.setWaitingOnOwner(false);
        await vi.advanceTimersByTimeAsync(STALL_MS - 1);

        expect(onStall)
            .not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(onStall)
            .toHaveBeenCalledTimes(1);
    });

    it('keeps waiting until every nested wait has ended', async () => {
        const onStall = vi.fn();
        const watch = new StallWatchdog(onStall);

        watch.start();
        watch.setWaitingOnOwner(true);
        watch.setWaitingOnOwner(true);
        watch.setWaitingOnOwner(false);
        await vi.advanceTimersByTimeAsync(20 * MINUTE_MS);

        expect(onStall)
            .not.toHaveBeenCalled();

        watch.setWaitingOnOwner(false);
        await vi.advanceTimersByTimeAsync(STALL_MS);

        expect(onStall)
            .toHaveBeenCalledTimes(1);
    });

    it('never fires after it is stopped', async () => {
        const onStall = vi.fn();
        const watch = new StallWatchdog(onStall);

        watch.start();
        watch.stop();
        await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

        expect(onStall)
            .not.toHaveBeenCalled();
    });
});
