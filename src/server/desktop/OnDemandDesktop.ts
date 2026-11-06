import { connect } from 'node:net';

// The desktop runs only while something holds it: a browser or desktop tool, a page connection or a Screen viewer.
// When nothing holds it and no turn runs, it stops after this long.
const DESKTOP_IDLE_STOP_MS = 10 * 60_000;
// Chromium and TigerVNC take a few seconds to start. A caller that waits longer gets an error.
const DESKTOP_READY_TIMEOUT_MS = 30_000;
const DESKTOP_READY_POLL_MS = 500;
const DESKTOP_READY_ATTEMPTS = DESKTOP_READY_TIMEOUT_MS / DESKTOP_READY_POLL_MS;
const PROBE_TIMEOUT_MS = 2_000;
const LOOPBACK_HOST = '127.0.0.1';

interface DesktopLifecycle {
    start: () => void;
    stop: () => void;
}

// Holds the desktop until the returned function is called. Calling that function again does nothing.
type DesktopHold = () => Promise<() => void>;

interface OnDemandDesktopOptions {
    supervisor: DesktopLifecycle;
    // Tests inject fakes here. Production checks the DevTools port and the VNC port, see isDesktopReady.
    isReady: () => Promise<boolean>;
    // A running turn may use the desktop, so the desktop stays up while one runs.
    isTurnRunning?: () => boolean;
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
    wait?: (delayMs: number) => Promise<void>;
    log?: (message: string) => void;
}

interface DesktopProbeOptions {
    devtoolsUrl: string;
    vncPort: number;
    // Tests inject a fake here.
    fetchFunction?: typeof fetch;
}

// Chromium answers on its DevTools port and TigerVNC accepts a connection. Both come up with the desktop.
async function isDesktopReady(options: DesktopProbeOptions): Promise<boolean> {
    const fetchFunction = options.fetchFunction ?? fetch;
    const answersDevtools = await isDevtoolsAnswering(fetchFunction, options.devtoolsUrl);

    if (!answersDevtools) {
        return false;
    }

    return isPortAccepting(options.vncPort);
}

async function isDevtoolsAnswering(fetchFunction: typeof fetch, devtoolsUrl: string): Promise<boolean> {
    try {
        const response = await fetchFunction(`${devtoolsUrl}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const body = await response.text();

        return response.ok && body.includes('"Browser"');
    } catch {
        return false;
    }
}

function isPortAccepting(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: LOOPBACK_HOST, port });

        socket.setTimeout(PROBE_TIMEOUT_MS, () => {
            socket.destroy();
        });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        // A refused connection, an error and a timeout all end here. The first answer is the one kept.
        socket.on('error', () => {
            resolve(false);
        });
        socket.once('close', () => {
            resolve(false);
        });
    });
}

function waitFor(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

// The release of a hold that holds nothing, for a caller that has no desktop.
function noRelease(): void {
    // Nothing is held.
}

// Holds the desktop when the caller has one. Without one, the caller runs with nothing held.
function holdDesktopIfAny(holdDesktop: DesktopHold | undefined): Promise<() => void> {
    return holdDesktop === undefined ? Promise.resolve(noRelease) : holdDesktop();
}

// Runs the desktop on demand. A caller holds it while it uses it, and the desktop stops after an idle period with no hold.
class OnDemandDesktop {
    private readonly supervisor: DesktopLifecycle;
    private readonly isReady: () => Promise<boolean>;
    private readonly isTurnRunning: () => boolean;
    private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    private readonly clearTimer: (timer: NodeJS.Timeout) => void;
    private readonly wait: (delayMs: number) => Promise<void>;
    private readonly log: (message: string) => void;
    private holdCount = 0;
    private idleTimer: NodeJS.Timeout | undefined;

    constructor(options: OnDemandDesktopOptions) {
        this.supervisor = options.supervisor;
        this.isReady = options.isReady;
        this.isTurnRunning = options.isTurnRunning ?? (() => false);
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.wait = options.wait ?? waitFor;
        this.log = options.log ?? console.error;
    }

    // Starts the desktop if it is down, and waits until it answers. The hold lasts until the returned function is called.
    async hold(): Promise<() => void> {
        this.cancelIdleStop();
        this.holdCount += 1;

        try {
            this.supervisor.start();
            await this.waitUntilReady(DESKTOP_READY_ATTEMPTS);
        } catch (error: unknown) {
            this.endHold();

            throw error;
        }

        let isReleased = false;

        return () => {
            if (!isReleased) {
                isReleased = true;
                this.endHold();
            }
        };
    }

    stop(): void {
        this.cancelIdleStop();
        this.supervisor.stop();
    }

    private endHold(): void {
        this.holdCount -= 1;

        if (this.holdCount === 0) {
            this.armIdleStop();
        }
    }

    private armIdleStop(): void {
        this.cancelIdleStop();
        this.idleTimer = this.setTimer(() => {
            this.idleTimer = undefined;
            this.stopIfUnused();
        }, DESKTOP_IDLE_STOP_MS);
    }

    // A turn that runs may use the desktop, so the idle period starts again.
    private stopIfUnused(): void {
        if (this.isTurnRunning()) {
            this.armIdleStop();

            return;
        }

        this.supervisor.stop();
    }

    private cancelIdleStop(): void {
        if (this.idleTimer !== undefined) {
            this.clearTimer(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    private async waitUntilReady(attemptsLeft: number): Promise<void> {
        if (await this.isReady()) {
            return;
        }

        if (attemptsLeft <= 1) {
            this.log('The desktop did not get ready in time.');

            throw new Error('The desktop did not get ready in time.');
        }

        await this.wait(DESKTOP_READY_POLL_MS);
        await this.waitUntilReady(attemptsLeft - 1);
    }
}

export { DESKTOP_IDLE_STOP_MS, DESKTOP_READY_ATTEMPTS, DESKTOP_READY_POLL_MS, OnDemandDesktop, holdDesktopIfAny, isDesktopReady };
export type { DesktopHold, DesktopLifecycle, DesktopProbeOptions, OnDemandDesktopOptions };
