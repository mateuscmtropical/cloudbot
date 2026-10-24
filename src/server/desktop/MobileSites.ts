import { devtoolsSocketUrl } from './BrowserControl.ts';
import { CdpConnection } from './CdpConnection.ts';
import type { CdpSocketFactory } from './CdpConnection.ts';

interface MobileSitesOptions {
    // The DevTools HTTP address of the desktop's Chromium, such as http://127.0.0.1:9222.
    devtoolsUrl: string;
    // Tests inject fakes here.
    fetchFunction?: typeof fetch;
    socketFactory?: CdpSocketFactory;
}

interface TargetInfo {
    targetId: string;
    type: string;
}

interface AttachedTarget {
    sessionId: string;
    targetInfo: TargetInfo;
    waitingForDebugger: boolean;
}

interface BrowserVersion {
    socketUrl: string;
    chromeMajor: string;
}

const DEVTOOLS_HTTP_TIMEOUT_MS = 5_000;
const FALLBACK_CHROME_MAJOR = '130';
const CHROME_MAJOR_PATTERN = /Chrome\/(\d+)/;
const MAX_TOUCH_POINTS = 5;

// The reduced user agent that Chrome on Android sends. Sites read it to pick their mobile page.
function mobileUserAgent(chromeMajor: string): string {
    return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;
}

function emulationCalls(chromeMajor: string): Array<[string, Record<string, unknown>]> {
    const userAgentMetadata = {
        brands: [{ brand: 'Chromium', version: chromeMajor }],
        platform: 'Android',
        platformVersion: '10.0.0',
        architecture: '',
        model: 'K',
        mobile: true,
    };

    return [
        ['Emulation.setUserAgentOverride', { userAgent: mobileUserAgent(chromeMajor), platform: 'Linux armv8l', userAgentMetadata }],
        ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: MAX_TOUCH_POINTS }],
        // A drag on the phone reaches Chromium as a mouse drag. As touch, it scrolls the page.
        ['Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }],
        // No mobile viewport. A page loaded before the phone took the screen keeps a 980 pixel layout there and gets cut off.
        // Without it every page lays out at the width of the window, which already is the width the phone asked for.
    ];
}

function isAttachedTarget(value: unknown): value is AttachedTarget {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const targetInfo: unknown = Reflect.get(value, 'targetInfo');

    return typeof Reflect.get(value, 'sessionId') === 'string'
        && typeof targetInfo === 'object' && targetInfo !== null
        && typeof Reflect.get(targetInfo, 'targetId') === 'string';
}

function readPageTargetIds(result: unknown): string[] {
    const targetInfos: unknown = typeof result === 'object' && result !== null ? Reflect.get(result, 'targetInfos') : undefined;
    const targets = Array.isArray(targetInfos) ? targetInfos as TargetInfo[] : [];

    return targets.filter(target => target.type === 'page')
        .map(target => target.targetId);
}

// While a phone holds the screen, the bot's Chromium asks sites for their mobile page.
// The overrides live on one DevTools connection, and Chromium drops them when it closes.
// So the desktop page comes back on the next load after the phone lets go.
// ponytail: an open page switches on its next load, not at once, so a form the bot filled is not lost to a reload.
class MobileSites {
    private readonly devtoolsUrl: string;
    private readonly fetchFunction: typeof fetch;
    private readonly socketFactory: CdpSocketFactory | undefined;
    private connection: CdpConnection | undefined;
    private opening: Promise<void> | undefined;
    private isWanted = false;

    constructor(options: MobileSitesOptions) {
        this.devtoolsUrl = options.devtoolsUrl;
        this.fetchFunction = options.fetchFunction ?? fetch;
        this.socketFactory = options.socketFactory;
    }

    // Waits for a start that is under way. Tests use it.
    get settled(): Promise<void> {
        return this.opening ?? Promise.resolve();
    }

    setActive(isActive: boolean): void {
        this.isWanted = isActive;

        if (!isActive) {
            this.connection?.close();
            this.connection = undefined;

            return;
        }

        const isRunning = this.connection?.isOpen === true || this.opening !== undefined;

        if (isRunning) {
            return;
        }

        this.opening = this.open()
            .catch(() => {
                // The browser may be down or restarting. Sites then stay on their desktop page.
            })
            .finally(() => {
                this.opening = undefined;
            });
    }

    private async open(): Promise<void> {
        const version = await this.readVersion();
        const connection = await CdpConnection.open(version.socketUrl, this.socketFactory);

        if (!this.isWanted) {
            connection.close();

            return;
        }

        this.connection = connection;

        const attachedTargetIds = new Set<string>();
        const calls = emulationCalls(version.chromeMajor);

        connection.onEvent((method, params) => {
            if (method !== 'Target.attachedToTarget' || !isAttachedTarget(params)) {
                return;
            }

            attachedTargetIds.add(params.targetInfo.targetId);
            this.emulate(connection, params, calls)
                .catch(() => {
                    // The page may have closed already.
                });
        });

        // New tabs wait until their overrides are set, so their first load asks for the mobile page.
        await connection.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

        const targets = await connection.call('Target.getTargets');
        const pageIds = readPageTargetIds(targets);
        const missingIds = pageIds.filter(targetId => !attachedTargetIds.has(targetId));
        const attachCalls = missingIds.map(targetId => connection.call('Target.attachToTarget', { targetId, flatten: true }));

        await Promise.all(attachCalls);
    }

    private async emulate(connection: CdpConnection, target: AttachedTarget, calls: Array<[string, Record<string, unknown>]>): Promise<void> {
        try {
            if (target.targetInfo.type === 'page') {
                const overrides = calls.map(([method, params]) => connection.call(method, params, undefined, target.sessionId));

                await Promise.all(overrides);
            }
        } finally {
            // Workers and frames also wait after an auto attach. They must run on even when they get no override.
            if (target.waitingForDebugger) {
                await connection.call('Runtime.runIfWaitingForDebugger', {}, undefined, target.sessionId);
            }
        }
    }

    private async readVersion(): Promise<BrowserVersion> {
        const signal = AbortSignal.timeout(DEVTOOLS_HTTP_TIMEOUT_MS);
        const response = await this.fetchFunction(`${this.devtoolsUrl}/json/version`, { signal });
        const version: unknown = await response.json();
        const rawSocketUrl: unknown = typeof version === 'object' && version !== null ? Reflect.get(version, 'webSocketDebuggerUrl') : undefined;
        const port = new URL(this.devtoolsUrl).port;
        const socketUrl = devtoolsSocketUrl(rawSocketUrl, port);

        if (socketUrl === undefined) {
            throw new Error('The browser gave an address that is not its own.');
        }

        const userAgent: unknown = typeof version === 'object' && version !== null ? Reflect.get(version, 'User-Agent') : undefined;
        const match = typeof userAgent === 'string' ? CHROME_MAJOR_PATTERN.exec(userAgent) : null;

        return { socketUrl, chromeMajor: match?.[1] ?? FALLBACK_CHROME_MAJOR };
    }
}

export { MobileSites, mobileUserAgent };
export type { MobileSitesOptions };
