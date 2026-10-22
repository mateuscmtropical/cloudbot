import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

// Every process of a turn inherits this variable, so the processes a turn leaves behind can be found after it ends.
// A command that starts its own session (setsid) leaves the CLI's process group, but it keeps the variable.
const TURN_MARKER_VARIABLE = 'CLOUDBOT_TURN_MARKER';
// The root-owned helper that ends the marked processes of the agent user. It runs as that user, see the sudoers file.
const END_TURN_HELPER_PATH = '/usr/local/bin/cloudbot-end-turn';
const MARKER_BYTES = 16;

function createTurnMarker(): string {
    return randomBytes(MARKER_BYTES)
        .toString('hex');
}

function readEnviron(procRoot: string, pid: string): string | undefined {
    try {
        return readFileSync(`${procRoot}/${pid}/environ`, 'latin1');
    } catch {
        // A process of another user cannot be read, and one that ended meanwhile is gone. Both are skipped.
        return undefined;
    }
}

function carriesMarker(environ: string, marker: string): boolean {
    const variables = environ.split('\0');

    return variables.includes(`${TURN_MARKER_VARIABLE}=${marker}`);
}

// Local mode on Linux: the turn's processes belong to the server user, so their environment can be read in /proc.
// Other systems have no /proc, so nothing is found there, and a leftover keeps running (a known limit).
function endLocalLeftovers(marker: string, procRoot = '/proc'): number[] {
    let entries: string[];

    try {
        entries = readdirSync(procRoot);
    } catch {
        return [];
    }

    const ownPid = String(process.pid);
    const pids = entries.filter(entry => /^\d+$/.test(entry) && entry !== ownPid);
    const marked = pids.filter((pid) => {
        const environ = readEnviron(procRoot, pid);

        return environ !== undefined && carriesMarker(environ, marker);
    });

    const markedPids = marked.map(Number);

    markedPids.forEach((pid) => {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // The process ended between the scan and the kill.
        }
    });

    return markedPids;
}

// Ends what a finished turn left running. Agent-user mode goes through the helper, since the processes belong to the
// bot user. A failure is only logged: the turn is over either way.
function endTurnLeftovers(marker: string, agentUser: string | undefined): void {
    if (process.platform !== 'linux') {
        return;
    }

    if (agentUser === undefined) {
        endLocalLeftovers(marker);

        return;
    }

    execFile('/usr/bin/sudo', ['-n', '-u', agentUser, '--', END_TURN_HELPER_PATH, marker], (error) => {
        if (error !== null) {
            console.error('Could not end the processes a turn left behind.');
        }
    });
}

export { END_TURN_HELPER_PATH, TURN_MARKER_VARIABLE, carriesMarker, createTurnMarker, endLocalLeftovers, endTurnLeftovers };
