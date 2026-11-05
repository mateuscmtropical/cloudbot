import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppUpdateState, AppUpdateStatus } from '../../shared/peopleTypes.ts';

const REQUEST_FILE = 'update-request';
const STATUS_FILE = 'update-status.json';
const KNOWN_STATES: readonly string[] = ['idle', 'running', 'done', 'failed'];
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UNAVAILABLE: AppUpdateStatus = { state: 'unavailable' };

// The hub cannot run a command on the server. It leaves a file in its data folder, and a systemd unit runs the update. The
// script of the server writes the status file, so a server without that unit has no status file and no update.
class AppUpdateRequests {
    constructor(private readonly dataDir: string) {}

    status(): AppUpdateStatus {
        let parsed: unknown;

        try {
            const statusPath = join(this.dataDir, STATUS_FILE);
            const text = readFileSync(statusPath, 'utf8');

            parsed = JSON.parse(text);
        } catch {
            return UNAVAILABLE;
        }

        const { state, commit, latest, at } = parsed as Record<string, unknown>;
        const isValid = typeof state === 'string' && KNOWN_STATES.includes(state)
            && typeof commit === 'string' && COMMIT_PATTERN.test(commit)
            && typeof latest === 'string' && COMMIT_PATTERN.test(latest)
            && typeof at === 'string';

        return isValid ? { state: state as AppUpdateState, commit, latest, at } : UNAVAILABLE;
    }

    // Answers the new status, or undefined when an update runs or this install has no update service.
    start(): AppUpdateStatus | undefined {
        const current = this.status();

        if (current.state === 'unavailable' || current.state === 'running') {
            return undefined;
        }

        const requestPath = join(this.dataDir, REQUEST_FILE);

        writeFileSync(requestPath, '');

        return { ...current, state: 'running' };
    }
}

export { AppUpdateRequests };
