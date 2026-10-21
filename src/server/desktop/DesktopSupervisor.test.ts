import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
    DesktopSupervisor,
    FIRST_RESTART_DELAY_MS,
    HEALTHY_RUN_MS,
    MAX_RESTART_DELAY_MS,
    buildDesktopCommand,
} from './DesktopSupervisor.ts';

interface FakeChild extends EventEmitter {
    killSignals: string[];
    kill: (signal: string) => boolean;
}

interface PendingTimer {
    callback: () => void;
    delayMs: number;
    isCleared: boolean;
}

interface Harness {
    supervisor: DesktopSupervisor;
    children: FakeChild[];
    spawnCalls: { command: string; args: string[] }[];
    timers: PendingTimer[];
    logs: string[];
    clock: { nowMs: number };
}

function createFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;

    child.killSignals = [];
    child.kill = (signal: string): boolean => {
        child.killSignals.push(signal);

        return true;
    };

    return child;
}

function createHarness(): Harness {
    const children: FakeChild[] = [];
    const spawnCalls: { command: string; args: string[] }[] = [];
    const timers: PendingTimer[] = [];
    const logs: string[] = [];
    const clock = { nowMs: 0 };
    const supervisor = new DesktopSupervisor({
        desktopCommand: { command: 'sudo', args: ['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-desktop'] },
        spawnFunction: (command, args) => {
            const child = createFakeChild();

            spawnCalls.push({ command, args });
            children.push(child);

            return child as unknown as ChildProcess;
        },
        setTimer: (callback, delayMs) => {
            const timer: PendingTimer = { callback, delayMs, isCleared: false };

            timers.push(timer);

            return timer as unknown as NodeJS.Timeout;
        },
        clearTimer: (timer) => {
            (timer as unknown as PendingTimer).isCleared = true;
        },
        now: () => clock.nowMs,
        log: (message) => {
            logs.push(message);
        },
    });

    return { supervisor, children, spawnCalls, timers, logs, clock };
}

describe('buildDesktopCommand', () => {
    it('returns nothing when no script is configured', () => {
        expect(buildDesktopCommand(undefined, 'bot'))
            .toBeUndefined();
        expect(buildDesktopCommand('', 'bot'))
            .toBeUndefined();
    });

    it('runs the script through sudo as the agent user without arguments', () => {
        expect(buildDesktopCommand('/usr/local/bin/cloudbot-desktop', 'bot'))
            .toEqual({
                command: 'sudo',
                args: ['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-desktop'],
            });
    });

    it('runs the script directly without an agent user', () => {
        expect(buildDesktopCommand('/opt/desktop', undefined))
            .toEqual({ command: '/opt/desktop', args: [] });
    });

    it('refuses a relative script path and an invalid user', () => {
        expect(() => buildDesktopCommand('cloudbot-desktop', 'bot'))
            .toThrow('absolute');
        expect(() => buildDesktopCommand('/usr/local/bin/cloudbot-desktop', 'bot; rm'))
            .toThrow('Invalid agent user');
    });
});

describe('DesktopSupervisor', () => {
    it('starts the desktop once', () => {
        const { supervisor, spawnCalls } = createHarness();

        supervisor.start();
        supervisor.start();

        expect(spawnCalls)
            .toEqual([{ command: 'sudo', args: ['-n', '-u', 'bot', '--', '/usr/local/bin/cloudbot-desktop'] }]);
        expect(supervisor.isRunning())
            .toBe(true);
    });

    it('starts the desktop again after it exits, with a doubling delay', () => {
        const { supervisor, children, spawnCalls, timers, logs } = createHarness();

        supervisor.start();
        children[0]?.emit('close', 1);

        expect(supervisor.isRunning())
            .toBe(false);
        expect(timers[0]?.delayMs)
            .toBe(FIRST_RESTART_DELAY_MS);
        expect(logs[0])
            .toContain('exited with code 1');

        timers[0]?.callback();
        children[1]?.emit('close', 1);

        expect(spawnCalls)
            .toHaveLength(2);
        expect(timers[1]?.delayMs)
            .toBe(FIRST_RESTART_DELAY_MS * 2);
    });

    it('caps the restart delay', () => {
        const { supervisor, children, timers } = createHarness();

        supervisor.start();
        Array.from({ length: 10 })
            .forEach((_unused, index) => {
                children[index]?.emit('close', 1);
                timers[index]?.callback();
            });

        expect(timers.at(-1)?.delayMs)
            .toBe(MAX_RESTART_DELAY_MS);
    });

    it('uses the short delay again after a healthy run', () => {
        const { supervisor, children, timers, clock } = createHarness();

        supervisor.start();
        children[0]?.emit('close', 1);
        timers[0]?.callback();
        clock.nowMs = HEALTHY_RUN_MS;
        children[1]?.emit('close', 0);

        expect(timers[1]?.delayMs)
            .toBe(FIRST_RESTART_DELAY_MS);
    });

    it('restarts once when a spawn error is followed by close', () => {
        const { supervisor, children, timers, logs } = createHarness();

        supervisor.start();
        children[0]?.emit('error', new Error('spawn sudo ENOENT'));
        children[0]?.emit('close', -2);

        expect(timers)
            .toHaveLength(1);
        expect(logs[0])
            .toBe('Could not start the desktop.');
    });

    it('stops the desktop and does not restart it', () => {
        const { supervisor, children, timers } = createHarness();

        supervisor.start();
        supervisor.stop();
        children[0]?.emit('close', null);

        expect(children[0]?.killSignals)
            .toEqual(['SIGTERM']);
        expect(timers)
            .toHaveLength(0);
        expect(supervisor.isRunning())
            .toBe(false);
    });

    it('cancels a planned restart on stop', () => {
        const { supervisor, children, timers } = createHarness();

        supervisor.start();
        children[0]?.emit('close', 1);
        supervisor.stop();

        expect(timers[0]?.isCleared)
            .toBe(true);
    });

    it('can start again after stop', () => {
        const { supervisor, children, spawnCalls, timers } = createHarness();

        supervisor.start();
        supervisor.stop();
        supervisor.start();
        children[0]?.emit('close', null);

        expect(spawnCalls)
            .toHaveLength(2);
        expect(supervisor.isRunning())
            .toBe(true);
        expect(timers)
            .toHaveLength(0);
    });
});
