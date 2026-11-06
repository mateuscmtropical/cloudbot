import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { DESKTOP_IDLE_STOP_MS, DESKTOP_READY_ATTEMPTS, OnDemandDesktop, isDesktopReady } from './OnDemandDesktop.ts';

interface PendingTimer {
    callback: () => void;
    delayMs: number;
    isCleared: boolean;
    hasFired: boolean;
}

interface Harness {
    desktop: OnDemandDesktop;
    calls: string[];
    timers: PendingTimer[];
    logs: string[];
    probes: { count: number };
    turn: { isRunning: boolean };
}

// The readiness answers in order. The last one repeats.
function createHarness(readiness: boolean[] = [true]): Harness {
    const calls: string[] = [];
    const timers: PendingTimer[] = [];
    const logs: string[] = [];
    const probes = { count: 0 };
    const turn = { isRunning: false };
    // Like DesktopSupervisor, starting a running desktop or stopping a stopped one does nothing.
    const running = { isRunning: false };
    const desktop = new OnDemandDesktop({
        supervisor: {
            start: () => {
                if (!running.isRunning) {
                    running.isRunning = true;
                    calls.push('start');
                }
            },
            stop: () => {
                if (running.isRunning) {
                    running.isRunning = false;
                    calls.push('stop');
                }
            },
        },
        isReady: () => {
            const answer = readiness[Math.min(probes.count, readiness.length - 1)];

            probes.count += 1;

            return Promise.resolve(answer === true);
        },
        isTurnRunning: () => turn.isRunning,
        setTimer: (callback, delayMs) => {
            const timer: PendingTimer = {
                callback: () => {
                    timer.hasFired = true;
                    callback();
                },
                delayMs,
                isCleared: false,
                hasFired: false,
            };

            timers.push(timer);

            return timer as unknown as NodeJS.Timeout;
        },
        clearTimer: (timer) => {
            (timer as unknown as PendingTimer).isCleared = true;
        },
        wait: () => Promise.resolve(),
        log: (message) => {
            logs.push(message);
        },
    });

    return { desktop, calls, timers, logs, probes, turn };
}

// The timers that would still fire. A cleared timer or one that already ran does not count.
function activeTimers(timers: PendingTimer[]): PendingTimer[] {
    return timers.filter(timer => !timer.isCleared && !timer.hasFired);
}

describe('OnDemandDesktop', () => {
    it('starts the desktop with the first hold, and not before', async () => {
        const { desktop, calls } = createHarness();

        expect(calls)
            .toEqual([]);

        await desktop.hold();

        expect(calls)
            .toEqual(['start']);
    });

    it('waits until the desktop answers before the hold is returned', async () => {
        const { desktop, calls, probes } = createHarness([false, false, true]);

        await desktop.hold();

        expect(calls)
            .toEqual(['start']);
        expect(probes.count)
            .toBe(3);
    });

    it('fails with an error after the bounded wait, and then the desktop stops after the idle period', async () => {
        const { desktop, calls, timers, logs, probes } = createHarness([false]);

        await expect(desktop.hold())
            .rejects.toThrow('The desktop did not get ready in time.');

        expect(probes.count)
            .toBe(DESKTOP_READY_ATTEMPTS);
        expect(logs)
            .toEqual(['The desktop did not get ready in time.']);

        timers[0]?.callback();

        expect(calls)
            .toEqual(['start', 'stop']);
    });

    it('stops the desktop after the idle period once the hold ends', async () => {
        const { desktop, calls, timers } = createHarness();
        const release = await desktop.hold();

        release();

        expect(timers[0]?.delayMs)
            .toBe(DESKTOP_IDLE_STOP_MS);

        timers[0]?.callback();

        expect(calls)
            .toEqual(['start', 'stop']);
    });

    it('a new hold cancels the idle stop', async () => {
        const { desktop, calls, timers } = createHarness();
        const first = await desktop.hold();

        first();

        const second = await desktop.hold();

        expect(timers[0]?.isCleared)
            .toBe(true);

        second();
        timers[1]?.callback();

        expect(calls)
            .toEqual(['start', 'stop']);
    });

    it('does not stop while a viewer holds it, even after the idle period', async () => {
        const { desktop, calls, timers } = createHarness();

        await desktop.hold();

        const action = await desktop.hold();

        action();

        expect(activeTimers(timers))
            .toHaveLength(0);
        expect(calls)
            .toEqual(['start']);
    });

    it('stops only after the last hold ends', async () => {
        const { desktop, calls, timers } = createHarness();
        const viewer = await desktop.hold();
        const action = await desktop.hold();

        action();
        viewer();

        expect(activeTimers(timers))
            .toHaveLength(1);

        timers[timers.length - 1]?.callback();

        expect(calls)
            .toEqual(['start', 'stop']);
    });

    it('releasing a hold twice does not end another hold early', async () => {
        const { desktop, timers } = createHarness();
        const first = await desktop.hold();

        await desktop.hold();
        first();
        first();

        expect(activeTimers(timers))
            .toHaveLength(0);
    });

    it('does not stop while a turn runs, and checks again after the idle period', async () => {
        const { desktop, calls, timers, turn } = createHarness();
        const release = await desktop.hold();

        release();
        turn.isRunning = true;
        timers[0]?.callback();

        expect(calls)
            .toEqual(['start']);
        expect(activeTimers(timers))
            .toHaveLength(1);

        turn.isRunning = false;
        timers[timers.length - 1]?.callback();

        expect(calls)
            .toEqual(['start', 'stop']);
    });

    it('starts again with the next hold after a stop', async () => {
        const { desktop, calls, timers } = createHarness();
        const release = await desktop.hold();

        release();
        timers[0]?.callback();
        await desktop.hold();

        expect(calls)
            .toEqual(['start', 'stop', 'start']);
    });
});

describe('isDesktopReady', () => {
    async function listeningPort(): Promise<number> {
        const server = createServer();

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address() as AddressInfo;

        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });

        return port;
    }

    function answeringDevtools(body: string): typeof fetch {
        return () => Promise.resolve(new Response(body));
    }

    it('is ready when DevTools answers and the VNC port accepts a connection', async () => {
        const server = createServer();

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address() as AddressInfo;

        try {
            const isReady = await isDesktopReady({ devtoolsUrl: 'http://127.0.0.1:9222', vncPort: port, fetchFunction: answeringDevtools('{"Browser":"Chromium/1"}') });

            expect(isReady)
                .toBe(true);
        } finally {
            server.close();
        }
    });

    it('is not ready when nothing accepts a connection on the VNC port', async () => {
        const closedPort = await listeningPort();
        const isReady = await isDesktopReady({ devtoolsUrl: 'http://127.0.0.1:9222', vncPort: closedPort, fetchFunction: answeringDevtools('{"Browser":"Chromium/1"}') });

        expect(isReady)
            .toBe(false);
    });

    it('is not ready when DevTools does not answer', async () => {
        const server = createServer();

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address() as AddressInfo;
        const refusing = (() => Promise.reject(new Error('refused'))) as unknown as typeof fetch;

        try {
            const isReady = await isDesktopReady({ devtoolsUrl: 'http://127.0.0.1:9222', vncPort: port, fetchFunction: refusing });

            expect(isReady)
                .toBe(false);
        } finally {
            server.close();
        }
    });
});
