import type { CdpConnection } from './CdpConnection.ts';

interface ViewportSize {
    width: number;
    height: number;
}

type ScreencastPage = Pick<CdpConnection, 'call'>;

interface ViewportRequest {
    owner: object;
    page: ScreencastPage;
    size: ViewportSize;
}

function setViewport(page: ScreencastPage, size: ViewportSize): Promise<void> {
    return page.call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false })
        .then(() => undefined);
}

function clearViewport(page: ScreencastPage): Promise<void> {
    return page.call('Emulation.clearDeviceMetricsOverride')
        .then(() => undefined);
}

// DevTools viewport overrides apply to the shared browser page. Coordinate all owner tabs
// so one panel cannot clear a newer panel's size when it closes.
class ScreencastViewportCoordinator {
    private requests: ViewportRequest[] = [];
    private pending: Promise<void> = Promise.resolve();

    request(owner: object, page: ScreencastPage, size: ViewportSize): Promise<void> {
        this.requests = this.requests.filter(request => request.owner !== owner);
        this.requests.push({ owner, page, size });

        return this.enqueue(() => setViewport(page, size));
    }

    release(owner: object, page: ScreencastPage): Promise<void> {
        const requestIndex = this.requests.findIndex(request => request.owner === owner);

        if (requestIndex < 0) {
            return Promise.resolve();
        }

        const wasLatest = requestIndex === this.requests.length - 1;

        this.requests.splice(requestIndex, 1);

        if (!wasLatest) {
            return Promise.resolve();
        }

        const latestRequest = this.requests.at(-1);

        if (latestRequest === undefined) {
            return this.enqueue(() => clearViewport(page));
        }

        return this.enqueue(() => setViewport(latestRequest.page, latestRequest.size));
    }

    restoreAll(): Promise<void> {
        if (this.requests.length === 0) {
            return Promise.resolve();
        }

        const latestRequest = this.requests.at(-1);

        if (latestRequest === undefined) {
            return Promise.resolve();
        }

        this.requests = [];

        return this.enqueue(() => clearViewport(latestRequest.page));
    }

    private enqueue(task: () => Promise<void>): Promise<void> {
        const operation = this.pending.then(task);

        this.pending = operation.catch(() => undefined);

        return operation;
    }
}

export { ScreencastViewportCoordinator };
