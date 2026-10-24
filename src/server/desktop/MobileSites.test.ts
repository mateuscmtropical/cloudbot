import { describe, expect, it } from 'vitest';

import { MobileSites, mobileUserAgent } from './MobileSites.ts';
import { createFakeSocketFactory } from './testCdp.ts';
import type { CdpAnswer, SentCall } from './testCdp.ts';

const DEVTOOLS_URL = 'http://127.0.0.1:9222';
const BROWSER_SOCKET_URL = 'ws://127.0.0.1:9222/devtools/browser/abc';
const VERSION = { 'webSocketDebuggerUrl': BROWSER_SOCKET_URL, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.6778.85 Safari/537.36' };

interface Harness {
    sites: MobileSites;
    sockets: ReturnType<typeof createFakeSocketFactory>;
    fetchedUrls: string[];
}

function attachedEvent(targetId: string, type: string, isWaiting: boolean): string {
    const params = { sessionId: `session-${targetId}`, targetInfo: { targetId, type }, waitingForDebugger: isWaiting };

    return JSON.stringify({ method: 'Target.attachedToTarget', params });
}

function createHarness(version: unknown = VERSION, pageIds: string[] = ['open-page']): Harness {
    const fetchedUrls: string[] = [];
    const fetchFunction = ((input: string | URL | Request): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();

        fetchedUrls.push(url);

        return Promise.resolve(Response.json(version));
    }) as typeof fetch;
    const holder: { sockets?: ReturnType<typeof createFakeSocketFactory> } = {};
    const answer: CdpAnswer = (call: SentCall) => {
        if (call.method === 'Target.getTargets') {
            const targetInfos = pageIds.map(targetId => ({ targetId, type: 'page' }));

            return { result: { targetInfos } };
        }

        if (call.method === 'Target.attachToTarget') {
            const targetId = String(call.params.targetId);

            queueMicrotask(() => {
                holder.sockets?.sockets[0]?.emit('message', { data: attachedEvent(targetId, 'page', false) });
            });
        }

        return { result: {} };
    };
    const sockets = createFakeSocketFactory(answer);

    holder.sockets = sockets;

    const sites = new MobileSites({ devtoolsUrl: DEVTOOLS_URL, fetchFunction, socketFactory: sockets.factory });

    return { sites, sockets, fetchedUrls };
}

function flush(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

function sessionCalls(sent: SentCall[], sessionId: string): string[] {
    return sent.filter(call => call.sessionId === sessionId)
        .map(call => call.method);
}

describe('MobileSites', () => {
    it('gives an open page the mobile user agent, touch and the phone viewport', async () => {
        const { sites, sockets, fetchedUrls } = createHarness();

        sites.setActive(true);
        await sites.settled;
        await flush();

        const sent = sockets.sockets[0]?.sent ?? [];
        const userAgentCall = sent.find(call => call.method === 'Emulation.setUserAgentOverride');

        expect(fetchedUrls)
            .toEqual([`${DEVTOOLS_URL}/json/version`]);
        expect(sockets.urls)
            .toEqual([BROWSER_SOCKET_URL]);
        expect(sent.find(call => call.method === 'Target.setAutoAttach')?.params)
            .toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        expect(sessionCalls(sent, 'session-open-page'))
            .toEqual(['Emulation.setUserAgentOverride', 'Emulation.setTouchEmulationEnabled', 'Emulation.setEmitTouchEventsForMouse', 'Emulation.setDeviceMetricsOverride']);
        expect(userAgentCall?.params.userAgent)
            .toBe(mobileUserAgent('131'));
        expect(mobileUserAgent('131'))
            .toContain('Mobile');
    });

    it('lets a new tab and a waiting worker run on after the overrides', async () => {
        const { sites, sockets } = createHarness(VERSION, []);

        sites.setActive(true);
        await sites.settled;

        const socket = sockets.sockets[0];

        socket?.emit('message', { data: attachedEvent('new-tab', 'page', true) });
        socket?.emit('message', { data: attachedEvent('worker', 'service_worker', true) });
        await flush();

        const sent = socket?.sent ?? [];

        expect(sessionCalls(sent, 'session-new-tab')
            .at(-1))
            .toBe('Runtime.runIfWaitingForDebugger');
        expect(sessionCalls(sent, 'session-new-tab'))
            .toHaveLength(5);
        expect(sessionCalls(sent, 'session-worker'))
            .toEqual(['Runtime.runIfWaitingForDebugger']);
    });

    it('closes the connection when the phone lets go, which drops the overrides', async () => {
        const { sites, sockets } = createHarness();

        sites.setActive(true);
        await sites.settled;
        sites.setActive(false);

        expect(sockets.sockets[0]?.isClosed)
            .toBe(true);
    });

    it('closes a connection that opens after the phone let go', async () => {
        const { sites, sockets } = createHarness();

        sites.setActive(true);
        sites.setActive(false);
        await sites.settled;

        expect(sockets.sockets[0]?.isClosed)
            .toBe(true);
        expect(sockets.sockets[0]?.sent)
            .toEqual([]);
    });

    it('opens one connection while the phone keeps resizing', async () => {
        const { sites, sockets } = createHarness();

        sites.setActive(true);
        sites.setActive(true);
        await sites.settled;
        sites.setActive(true);

        expect(sockets.sockets)
            .toHaveLength(1);
    });

    it('does not connect to an address that is not the browser\'s own', async () => {
        const { sites, sockets } = createHarness({ webSocketDebuggerUrl: 'ws://10.0.0.5:9222/devtools/browser/abc' });

        sites.setActive(true);
        await sites.settled;

        expect(sockets.sockets)
            .toHaveLength(0);
    });
});
