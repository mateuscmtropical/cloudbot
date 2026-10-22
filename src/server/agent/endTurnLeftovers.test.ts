import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { TURN_MARKER_VARIABLE, carriesMarker, createTurnMarker, endLocalLeftovers } from './endTurnLeftovers.ts';

const HELPER_PATH = fileURLToPath(new URL('../../../docker/cloudbot-end-turn', import.meta.url));

// A killed process whose parent already exited may wait as a zombie until init reaps it, so a zombie counts as gone.
function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }

    const statPath = `/proc/${String(pid)}/stat`;

    if (!existsSync(statPath)) {
        return true;
    }

    const stat = readFileSync(statPath, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);

    return state !== 'Z';
}

// A process in its own session, as a command that used setsid would be. It is outside the CLI's process group.
function startDetachedSleep(environment: Record<string, string>): number {
    const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', ...environment } });

    child.unref();

    return child.pid ?? -1;
}

describe('createTurnMarker', () => {
    it('makes a new marker of 32 lowercase hex characters for each turn', () => {
        const first = createTurnMarker();
        const second = createTurnMarker();

        expect(first)
            .toMatch(/^[0-9a-f]{32}$/);
        expect(first)
            .not.toBe(second);
    });
});

describe('carriesMarker', () => {
    it('matches the whole variable only', () => {
        const marker = createTurnMarker();

        expect(carriesMarker(`PATH=/bin\0${TURN_MARKER_VARIABLE}=${marker}\0`, marker))
            .toBe(true);
        expect(carriesMarker(`${TURN_MARKER_VARIABLE}=${marker}x\0`, marker))
            .toBe(false);
        expect(carriesMarker(`OTHER_${TURN_MARKER_VARIABLE}=${marker}\0`, marker))
            .toBe(false);
    });
});

describe('endLocalLeftovers', () => {
    it('reads each process in the proc folder and skips the ones it cannot read', () => {
        const procRoot = mkdtempSync(join(tmpdir(), 'cloudbot-proc-'));
        const marker = createTurnMarker();
        const kill = vi.spyOn(process, 'kill')
            .mockImplementation(() => true);

        mkdirSync(join(procRoot, '4001'));
        writeFileSync(join(procRoot, '4001', 'environ'), `${TURN_MARKER_VARIABLE}=${marker}\0`);
        mkdirSync(join(procRoot, '4002'));
        writeFileSync(join(procRoot, '4002', 'environ'), 'PATH=/bin\0');
        mkdirSync(join(procRoot, '4003'));
        mkdirSync(join(procRoot, 'self'));

        const ended = endLocalLeftovers(marker, procRoot);

        expect(ended)
            .toEqual([4001]);
        expect(kill)
            .toHaveBeenCalledWith(4001, 'SIGKILL');
        kill.mockRestore();
    });

    it.skipIf(process.platform !== 'linux')('ends a real process in its own session that carries the marker, and leaves others', async () => {
        const marker = createTurnMarker();
        const markedPid = startDetachedSleep({ [TURN_MARKER_VARIABLE]: marker });
        const otherPid = startDetachedSleep({});

        await vi.waitFor(() => {
            expect(existsSync(`/proc/${String(markedPid)}/environ`))
                .toBe(true);
        });
        endLocalLeftovers(marker);

        await vi.waitFor(() => {
            expect(isProcessAlive(markedPid))
                .toBe(false);
        });
        expect(isProcessAlive(otherPid))
            .toBe(true);
        process.kill(otherPid, 'SIGKILL');
    });
});

describe.skipIf(process.platform !== 'linux')('cloudbot-end-turn', () => {
    function runHelper(args: string[]): number | null {
        return spawnSync('sh', [HELPER_PATH, ...args], { encoding: 'utf8' }).status;
    }

    it.each([
        ['no arguments', []],
        ['two arguments', [createTurnMarker(), 'extra']],
        ['upper case', ['0123456789ABCDEF0123456789ABCDEF']],
        ['a short marker', ['0123abcd']],
        ['a long marker', [`${createTurnMarker()}0`]],
        ['a shell fragment', ['0123456789abcdef0123456789abcde;']],
        ['an empty marker', ['']],
    ])('rejects %s', (_label, args) => {
        expect(runHelper(args))
            .toBe(2);
    });

    it('ends a real marked process in its own session, and leaves an unmarked one', async () => {
        const marker = createTurnMarker();
        const markedPid = startDetachedSleep({ [TURN_MARKER_VARIABLE]: marker });
        const otherPid = startDetachedSleep({});

        await vi.waitFor(() => {
            expect(existsSync(`/proc/${String(markedPid)}/environ`))
                .toBe(true);
        });

        expect(runHelper([marker]))
            .toBe(0);
        await vi.waitFor(() => {
            expect(isProcessAlive(markedPid))
                .toBe(false);
        });
        expect(isProcessAlive(otherPid))
            .toBe(true);
        process.kill(otherPid, 'SIGKILL');
    });
});
