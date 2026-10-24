import { describe, expect, it } from 'vitest';

import { ScreencastViewportCoordinator } from './ScreencastViewportCoordinator.ts';

interface FakePage {
    calls: Array<{ method: string; params: Record<string, unknown> }>;
    call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

function makePage(): FakePage {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    return {
        calls,
        call: (method, params = {}) => {
            calls.push({ method, params });

            return Promise.resolve(undefined);
        },
    };
}

describe('ScreencastViewportCoordinator', () => {
    it('does not let an older panel change the latest panel size when it closes', async () => {
        const coordinator = new ScreencastViewportCoordinator();
        const firstOwner = {};
        const secondOwner = {};
        const firstPage = makePage();
        const secondPage = makePage();

        await coordinator.request(firstOwner, firstPage, { width: 390, height: 680 });
        await coordinator.request(secondOwner, secondPage, { width: 500, height: 870 });
        await coordinator.release(firstOwner, firstPage);

        expect(firstPage.calls)
            .toHaveLength(1);
        expect(secondPage.calls)
            .toEqual([{ method: 'Emulation.setDeviceMetricsOverride', params: { width: 500, height: 870, deviceScaleFactor: 1, mobile: false } }]);
    });

    it('restores the latest surviving viewport when the newest panel closes', async () => {
        const coordinator = new ScreencastViewportCoordinator();
        const firstOwner = {};
        const secondOwner = {};
        const firstPage = makePage();
        const secondPage = makePage();

        await coordinator.request(firstOwner, firstPage, { width: 390, height: 680 });
        await coordinator.request(secondOwner, secondPage, { width: 500, height: 870 });
        await coordinator.release(secondOwner, secondPage);

        expect(firstPage.calls)
            .toHaveLength(2);
        expect(firstPage.calls[1])
            .toEqual({ method: 'Emulation.setDeviceMetricsOverride', params: { width: 390, height: 680, deviceScaleFactor: 1, mobile: false } });
    });

    it('clears the viewport after the last panel closes or the owner gives up the screen', async () => {
        const coordinator = new ScreencastViewportCoordinator();
        const owner = {};
        const page = makePage();

        await coordinator.request(owner, page, { width: 390, height: 680 });
        await coordinator.release(owner, page);
        await coordinator.request(owner, page, { width: 390, height: 680 });
        await coordinator.restoreAll();
        await coordinator.restoreAll();

        expect(page.calls.map(call => call.method))
            .toEqual([
                'Emulation.setDeviceMetricsOverride',
                'Emulation.clearDeviceMetricsOverride',
                'Emulation.setDeviceMetricsOverride',
                'Emulation.clearDeviceMetricsOverride',
            ]);
    });
});
