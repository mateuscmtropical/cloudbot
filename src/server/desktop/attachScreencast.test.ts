import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SetupAccess } from '../access/SetupAccess.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { attachScreencast } from './attachScreencast.ts';
import type { BrowserControl } from './BrowserControl.ts';
import type { CdpEventListener } from './CdpConnection.ts';
import { ScreenHolder } from './ScreenHolder.ts';
import type { ScreencastPage } from './screencast.ts';

interface FakePage {
    page: ScreencastPage;
    calls: string[];
    isClosed: () => boolean;
    emit: (method: string, params: unknown) => void;
}

// Records the calls. The frames and the close are driven by the test.
function createFakePage(): FakePage {
    const calls: string[] = [];
    let listener: CdpEventListener | undefined;
    let isClosed = false;
    const page: ScreencastPage = {
        call: (method: string) => {
            calls.push(method);

            return Promise.resolve(undefined);
        },
        onEvent: (nextListener: CdpEventListener) => {
            listener = nextListener;
        },
        close: () => {
            isClosed = true;
        },
    };

    return {
        page,
        calls,
        isClosed: () => isClosed,
        emit: (method: string, params: unknown) => {
            listener?.(method, params);
        },
    };
}

function listenOnFreePort(server: Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port);
        });
    });
}

// Polls until the condition holds, so the server side has reached the step the test waits for.
async function waitUntil(condition: () => boolean, attemptsLeft = 200): Promise<void> {
    if (condition() || attemptsLeft === 0) {
        return;
    }

    await new Promise((resolve) => {
        setTimeout(resolve, 10);
    });

    return waitUntil(condition, attemptsLeft - 1);
}

describe('attachScreencast', () => {
    let opened: OpenedDatabase;
    let access: SetupAccess;
    let httpServer: Server;
    let httpPort: number;
    let sessionToken: string;
    let fake: FakePage;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
        fake = createFakePage();
        const browser = { connectPage: () => Promise.resolve(fake.page) } as unknown as BrowserControl;

        httpServer = createServer();
        attachScreencast({ server: httpServer, access, browser, screen: new ScreenHolder() });
        httpPort = await listenOnFreePort(httpServer);

        const setupCode = await access.issueSetupCode();
        const redeemedToken = await access.redeemSetupCode(setupCode);

        if (redeemedToken === undefined) {
            throw new Error('The setup code was not accepted.');
        }

        sessionToken = redeemedToken;
    });

    afterEach(() => {
        httpServer.close();
        httpServer.closeAllConnections();
    });

    it('sends the frames of the browser page to a signed-in owner', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/screencast`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(httpPort)}` },
        });
        const firstMessage = new Promise<string>((resolve) => {
            webSocket.on('message', (data: Buffer) => {
                resolve(data.toString());
            });
        });

        await waitUntil(() => fake.calls.includes('Page.startScreencast'));
        fake.emit('Page.screencastFrame', { data: 'AAAA', sessionId: 3, metadata: { deviceWidth: 1280, deviceHeight: 800 } });

        expect(JSON.parse(await firstMessage))
            .toEqual({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });

        webSocket.close();
    });

    it('accepts a request with the matching hub secret and no owner cookie', async () => {
        const browser = { connectPage: () => Promise.resolve(fake.page) } as unknown as BrowserControl;
        const hubServer = createServer();

        attachScreencast({ server: hubServer, access, hubSecret: 'instance-secret', browser, screen: new ScreenHolder() });
        const hubPort = await listenOnFreePort(hubServer);
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(hubPort)}/api/desktop/screencast`, {
            headers: { 'origin': `http://127.0.0.1:${String(hubPort)}`, 'x-cloudbot-hub': 'instance-secret' },
        });
        const firstMessage = new Promise<string>((resolve) => {
            webSocket.on('message', (data: Buffer) => {
                resolve(data.toString());
            });
        });

        await waitUntil(() => fake.calls.includes('Page.startScreencast'));
        fake.emit('Page.screencastFrame', { data: 'AAAA', sessionId: 3, metadata: { deviceWidth: 1280, deviceHeight: 800 } });

        expect(JSON.parse(await firstMessage))
            .toEqual({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });

        webSocket.close();
        hubServer.closeAllConnections();
        hubServer.close();
    });

    it('refuses the upgrade without a session', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/screencast`, { headers: { origin: `http://127.0.0.1:${String(httpPort)}` } });
        const status = await new Promise<string>((resolve) => {
            webSocket.on('unexpected-response', (_request, response) => {
                resolve(String(response.statusCode));
            });
            webSocket.on('error', () => {
                resolve('error');
            });
        });

        expect(status)
            .toBe('401');
        expect(fake.calls)
            .toEqual([]);
    });

    it('stops the screencast and closes the page when the owner leaves', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/screencast`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(httpPort)}` },
        });

        await waitUntil(() => fake.calls.includes('Page.startScreencast'));
        webSocket.close();
        await waitUntil(() => fake.isClosed());

        expect(fake.calls)
            .toContain('Page.stopScreencast');
        expect(fake.isClosed())
            .toBe(true);
    });
});
