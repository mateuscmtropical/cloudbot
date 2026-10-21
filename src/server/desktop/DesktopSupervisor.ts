import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

interface DesktopCommand {
    command: string;
    args: string[];
}

type DesktopSpawnFunction = (command: string, args: string[]) => ChildProcess;

interface DesktopSupervisorOptions {
    desktopCommand: DesktopCommand;
    // Tests inject fakes here. Production uses node:child_process and real timers.
    spawnFunction?: DesktopSpawnFunction;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
    now?: () => number;
    log?: (message: string) => void;
}

const FIRST_RESTART_DELAY_MS = 2_000;
const MAX_RESTART_DELAY_MS = 60_000;
// A desktop that ran this long counts as healthy, so the next restart is quick again.
const HEALTHY_RUN_MS = 60_000;
const DESKTOP_USER_PATTERN = /^[a-z_][a-z0-9_-]*$/;

function spawnDesktopProcess(command: string, args: string[]): ChildProcess {
    // The desktop writes its own log in the bot home, so its output is not needed here.
    return spawn(command, args, { stdio: 'ignore', shell: false });
}

// With an agent user, sudo starts the script as that user. sudoers allows it only without arguments.
function buildDesktopCommand(scriptPath: string | undefined, agentUser: string | undefined): DesktopCommand | undefined {
    if (scriptPath === undefined || scriptPath === '') {
        return undefined;
    }

    if (!scriptPath.startsWith('/')) {
        throw new Error('CLOUDBOT_DESKTOP_COMMAND must be an absolute path.');
    }

    if (agentUser === undefined || agentUser === '') {
        return { command: scriptPath, args: [] };
    }

    if (!DESKTOP_USER_PATTERN.test(agentUser)) {
        throw new Error('Invalid agent user.');
    }

    return { command: 'sudo', args: ['-n', '-u', agentUser, '--', scriptPath] };
}

// Keeps the desktop running. When it exits, it starts again after a delay that doubles up to a minute.
class DesktopSupervisor {
    private readonly options: DesktopSupervisorOptions;
    private readonly spawnFunction: DesktopSpawnFunction;
    private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout) => void;
    private readonly now: () => number;
    private readonly log: (message: string) => void;
    private child: ChildProcess | undefined;
    private restartTimer: NodeJS.Timeout | undefined;
    private restartDelayMs = FIRST_RESTART_DELAY_MS;
    private startedAt = 0;
    private isStopped = true;

    constructor(options: DesktopSupervisorOptions) {
        this.options = options;
        this.spawnFunction = options.spawnFunction ?? spawnDesktopProcess;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.now = options.now ?? Date.now;
        this.log = options.log ?? console.error;
    }

    isRunning(): boolean {
        return this.child !== undefined;
    }

    start(): void {
        if (!this.isStopped) {
            return;
        }

        this.isStopped = false;
        this.launch();
    }

    stop(): void {
        this.isStopped = true;

        if (this.restartTimer !== undefined) {
            this.clearTimer(this.restartTimer);
            this.restartTimer = undefined;
        }

        // sudo passes SIGTERM on to the script, which stops its children.
        this.child?.kill('SIGTERM');
        this.child = undefined;
    }

    private launch(): void {
        const { command, args } = this.options.desktopCommand;
        const child = this.spawnFunction(command, args);

        this.child = child;
        this.startedAt = this.now();
        // A failed spawn emits error and then close, so the restart is planned once, on close.
        child.once('error', () => {
            this.log('Could not start the desktop.');
        });
        child.once('close', (code: number | null) => {
            this.handleClose(child, code);
        });
    }

    private handleClose(child: ChildProcess, code: number | null): void {
        // A child from before stop() or from an older launch is not the current one.
        if (this.child !== child) {
            return;
        }

        this.child = undefined;

        if (this.isStopped) {
            return;
        }

        const ranMs = this.now() - this.startedAt;

        if (ranMs >= HEALTHY_RUN_MS) {
            this.restartDelayMs = FIRST_RESTART_DELAY_MS;
        }

        const delayMs = this.restartDelayMs;

        this.restartDelayMs = Math.min(this.restartDelayMs * 2, MAX_RESTART_DELAY_MS);
        this.log(`The desktop exited with code ${String(code)}. Starting it again in ${String(delayMs / 1000)} s.`);
        this.restartTimer = this.setTimer(() => {
            this.restartTimer = undefined;
            this.launch();
        }, delayMs);
    }
}

export { DesktopSupervisor, FIRST_RESTART_DELAY_MS, HEALTHY_RUN_MS, MAX_RESTART_DELAY_MS, buildDesktopCommand };
export type { DesktopCommand, DesktopSpawnFunction, DesktopSupervisorOptions };
