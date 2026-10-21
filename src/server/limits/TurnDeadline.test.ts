import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TurnDeadline } from './TurnDeadline.ts';

const MINUTE_MS = 60_000;

describe('TurnDeadline', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires once when the work time runs out', async () => {
        const onExpire = vi.fn();
        const deadline = new TurnDeadline(MINUTE_MS, onExpire);

        deadline.start();
        await vi.advanceTimersByTimeAsync(MINUTE_MS - 1);

        expect(onExpire)
            .not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(onExpire)
            .toHaveBeenCalledTimes(1);
    });

    it('holds the clock while the owner is asked, and counts only the work time', async () => {
        const onExpire = vi.fn();
        const deadline = new TurnDeadline(MINUTE_MS, onExpire);

        deadline.start();
        await vi.advanceTimersByTimeAsync(30_000);
        deadline.setWaitingOnHuman(true);
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(onExpire)
            .not.toHaveBeenCalled();

        deadline.setWaitingOnHuman(false);
        await vi.advanceTimersByTimeAsync(29_999);

        expect(onExpire)
            .not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);

        expect(onExpire)
            .toHaveBeenCalledTimes(1);
    });

    it('runs the clock again only when every nested wait has ended', async () => {
        const onExpire = vi.fn();
        const deadline = new TurnDeadline(MINUTE_MS, onExpire);

        deadline.start();
        deadline.setWaitingOnHuman(true);
        deadline.setWaitingOnHuman(true);
        deadline.setWaitingOnHuman(false);
        await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

        expect(onExpire)
            .not.toHaveBeenCalled();

        deadline.setWaitingOnHuman(false);
        await vi.advanceTimersByTimeAsync(MINUTE_MS);

        expect(onExpire)
            .toHaveBeenCalledTimes(1);
    });

    it('does not fire after it is stopped', async () => {
        const onExpire = vi.fn();
        const deadline = new TurnDeadline(MINUTE_MS, onExpire);

        deadline.start();
        deadline.stop();
        await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

        expect(onExpire)
            .not.toHaveBeenCalled();
    });
});
