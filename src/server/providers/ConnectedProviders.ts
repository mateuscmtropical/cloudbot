import type { ProviderId } from './providerIds.ts';

// A check of the sign-ins can take a minute, since each provider is asked through its own CLI. The answer is kept this long.
const CONNECTED_FRESH_MS = 20_000;

interface ConnectedCheck {
    connected: ProviderId[];
    checkedAt: number;
    // The sign-ins changed since this check when this number is behind.
    version: number;
}

// Keeps the last answer about the connected providers, so a page or a turn does not wait for the CLIs each time.
class ConnectedProviders {
    private lastCheck: ConnectedCheck | undefined;
    private runningCheck: Promise<ConnectedCheck> | undefined;

    constructor(
        private readonly askProviders: () => Promise<ProviderId[]>,
        private readonly readVersion: () => number = () => 0,
    ) {}

    // The providers the last finished check saw, or undefined before the first one.
    last(): ProviderId[] | undefined {
        return this.lastCheck?.connected;
    }

    // Asks the providers now. A check already running is shared.
    check(): Promise<ProviderId[]> {
        return this.startCheck()
            .then(check => check.connected);
    }

    // The last answer is used at once, and an old one is checked again in the background. Only the first call, and the first
    // after a sign-in changed, waits for the CLIs. A check that was running during the change does not count.
    async read(): Promise<ProviderId[]> {
        const version = this.readVersion();

        if (this.lastCheck === undefined || this.lastCheck.version !== version) {
            const check = await this.startCheck();
            const current = check.version === version ? check : await this.startCheck();

            return current.connected;
        }

        if (Date.now() - this.lastCheck.checkedAt > CONNECTED_FRESH_MS) {
            this.startCheck()
                .catch(() => undefined);
        }

        return this.lastCheck.connected;
    }

    private startCheck(): Promise<ConnectedCheck> {
        if (this.runningCheck !== undefined) {
            return this.runningCheck;
        }

        const version = this.readVersion();
        const check = this.askProviders()
            .then((connected) => {
                this.lastCheck = { connected, checkedAt: Date.now(), version };

                return this.lastCheck;
            })
            .finally(() => {
                this.runningCheck = undefined;
            });

        this.runningCheck = check;

        return check;
    }
}

export { ConnectedProviders };
