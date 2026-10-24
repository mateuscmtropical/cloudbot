import { createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SetupAccess } from '../access/SetupAccess.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { attachVncProxy } from './attachVncProxy.ts';
import { buildSetDesktopSizeMessage } from './RfbInputFilter.ts';
import { ScreenHolder } from './ScreenHolder.ts';

function listenOnFreePort(server: Server | TcpServer): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve((server.address() as AddressInfo).port);
        });
    });
}

function waitForOutcome(webSocket: WebSocket): Promise<string> {
    return new Promise((resolve) => {
        webSocket.on('message', (data: Buffer) => {
            resolve(`message:${data.toString()}`);
        });
        webSocket.on('unexpected-response', (_request, response) => {
            resolve(`status:${String(response.statusCode)}`);
        });
        webSocket.on('error', () => {
            resolve('error');
        });
    });
}

describe('attachVncProxy', () => {
    let opened: OpenedDatabase;
    let access: SetupAccess;
    let httpServer: Server;
    let vncServer: TcpServer;
    let httpPort: number;
    let sessionToken: string;
    let screen: ScreenHolder;
    let receivedVncBytes: Buffer[];

    beforeEach(async () => {
        screen = new ScreenHolder();
        receivedVncBytes = [];
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
        vncServer = createTcpServer((connection) => {
            connection.write('RFB 003.008\n');
            connection.on('data', (chunk) => {
                receivedVncBytes.push(Buffer.from(chunk));
                connection.write(chunk);
            });
        });

        const vncPort = await listenOnFreePort(vncServer);

        httpServer = createServer();
        attachVncProxy({ server: httpServer, access, screen, vncPort });
        httpPort = await listenOnFreePort(httpServer);

        const setupCode = await access.issueSetupCode();
        const redeemedToken = await access.redeemSetupCode(setupCode);

        if (redeemedToken === undefined) {
            throw new Error('The setup code was not accepted.');
        }

        sessionToken = redeemedToken;
    });

    async function connectAndRequestPortraitResize(size: { width: number; height: number } = { width: 400, height: 800 }): Promise<WebSocket> {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(httpPort)}` },
        });
        const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
        const resize = buildSetDesktopSizeMessage(size);

        await new Promise<void>((resolve) => {
            webSocket.on('open', resolve);
        });
        webSocket.send(Buffer.concat([handshake, resize]));
        await vi.waitFor(() => {
            const received = Buffer.concat(receivedVncBytes);

            expect(received.includes(resize))
                .toBe(true);
        });

        return webSocket;
    }

    async function waitForDefaultDesktopResize(): Promise<void> {
        const reset = buildSetDesktopSizeMessage({ width: 1280, height: 800 });

        await vi.waitFor(() => {
            const received = Buffer.concat(receivedVncBytes);

            expect(received.includes(reset))
                .toBe(true);
        });
    }

    afterEach(() => {
        httpServer.closeAllConnections();
        httpServer.close();
        vncServer.close();
        opened.close();
    });

    it('refuses a request without the session cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, { headers: { origin: `http://127.0.0.1:${String(httpPort)}` } });

        expect(await waitForOutcome(webSocket))
            .toBe('status:401');
    });

    it('refuses a page of another localhost port, even with a valid cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: 'http://localhost:5173' },
        });

        expect(await waitForOutcome(webSocket))
            .toBe('status:403');
    });

    it('accepts the host of the public address, and still refuses other hosts', async () => {
        const vncPort = (vncServer.address() as AddressInfo).port;
        const publicServer = createServer();

        attachVncProxy({ server: publicServer, access, screen, vncPort, publicUrl: 'https://cloudbot.example.com/' });

        const publicPort = await listenOnFreePort(publicServer);
        const cookie = `cloudbot_session=${sessionToken}`;
        const allowed = new WebSocket(`ws://127.0.0.1:${String(publicPort)}/api/desktop/vnc`, {
            headers: { cookie, origin: 'https://cloudbot.example.com' },
        });
        const refused = new WebSocket(`ws://127.0.0.1:${String(publicPort)}/api/desktop/vnc`, {
            headers: { cookie, origin: 'https://evil.example.com' },
        });

        const [allowedOutcome, refusedOutcome] = await Promise.all([waitForOutcome(allowed), waitForOutcome(refused)]);

        expect(allowedOutcome)
            .toBe('message:RFB 003.008\n');
        expect(refusedOutcome)
            .toBe('status:403');
        publicServer.closeAllConnections();
        publicServer.close();
    });

    it('refuses a request with a wrong session cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: 'cloudbot_session=wrong', origin: `http://127.0.0.1:${String(httpPort)}` },
        });

        expect(await waitForOutcome(webSocket))
            .toBe('status:401');
    });

    it('forwards the VNC greeting and the client bytes with a valid cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(httpPort)}` },
        });
        const messages: string[] = [];
        const received = new Promise<void>((resolve) => {
            webSocket.on('message', (data: Buffer) => {
                messages.push(data.toString());

                if (messages.length === 1) {
                    webSocket.send(Buffer.from('RFB 003.008\n'));
                }

                if (messages.length === 2) {
                    resolve();
                }
            });
        });

        await received;
        webSocket.close();

        expect(messages)
            .toEqual(['RFB 003.008\n', 'RFB 003.008\n']);
    });

    it('accepts a request with the matching hub secret and no owner cookie', async () => {
        const vncPort = (vncServer.address() as AddressInfo).port;
        const hubServer = createServer();

        attachVncProxy({ server: hubServer, access, hubSecret: 'instance-secret', screen, vncPort });
        const hubPort = await listenOnFreePort(hubServer);
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(hubPort)}/api/desktop/vnc`, {
            headers: { 'origin': `http://127.0.0.1:${String(hubPort)}`, 'x-cloudbot-hub': 'instance-secret' },
        });
        const outcome = await waitForOutcome(webSocket);

        expect(outcome)
            .toBe('message:RFB 003.008\n');

        webSocket.close();
        hubServer.closeAllConnections();
        hubServer.close();
    });

    it('closes the socket when the desktop is not running', async () => {
        vncServer.close();
        httpServer.closeAllConnections();

        const secondServer = createServer();
        const secondPort = await listenOnFreePort(secondServer);
        const deadVncServer = createTcpServer();
        const deadVncPort = await listenOnFreePort(deadVncServer);

        await new Promise<void>((resolve) => {
            deadVncServer.close(() => {
                resolve();
            });
        });

        attachVncProxy({ server: secondServer, access, screen, vncPort: deadVncPort });

        const webSocket = new WebSocket(`ws://127.0.0.1:${String(secondPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(secondPort)}` },
        });
        const closed = new Promise<string>((resolve) => {
            webSocket.on('close', () => {
                resolve('closed');
            });
        });

        expect(await closed)
            .toBe('closed');
        secondServer.close();
    });

    describe('input while the bot holds the screen', () => {
        const HANDSHAKE = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
        const POINTER = Buffer.from([5, 1, 0, 10, 0, 10]);
        const UPDATE_REQUEST = Buffer.from([3, 0, 0, 0, 0, 0, 5, 0, 5, 0]);

        // The fake desktop echoes the bytes it gets. The test reads them back until the update request arrives.
        async function sendAndCollect(): Promise<Buffer> {
            const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
                headers: { cookie: `cloudbot_session=${sessionToken}`, origin: `http://127.0.0.1:${String(httpPort)}` },
            });
            let echoed = Buffer.alloc(0);
            const done = new Promise<void>((resolve) => {
                webSocket.on('message', (data: Buffer) => {
                    echoed = Buffer.concat([echoed, data]);

                    if (echoed.includes(UPDATE_REQUEST)) {
                        resolve();
                    }
                });
            });

            await new Promise<void>((resolve) => {
                webSocket.on('open', resolve);
            });
            webSocket.send(HANDSHAKE);
            webSocket.send(POINTER);
            webSocket.send(UPDATE_REQUEST);
            await done;
            webSocket.close();

            return echoed;
        }

        it('drops mouse input from the browser', async () => {
            const echoed = await sendAndCollect();

            expect(echoed.includes(POINTER))
                .toBe(false);
        });

        it('forwards mouse input while a person holds the screen', async () => {
            screen.giveToPerson();

            const echoed = await sendAndCollect();

            expect(echoed.includes(POINTER))
                .toBe(true);
        });
    });

    it('restores the default desktop size when the owner gives the screen back', async () => {
        screen.giveToPerson();
        const webSocket = await connectAndRequestPortraitResize();

        screen.giveToBot();
        await waitForDefaultDesktopResize();
        webSocket.close();
    });

    it('restores the default desktop size when the owner closes the screen panel', async () => {
        screen.giveToPerson();
        const webSocket = await connectAndRequestPortraitResize();

        webSocket.close();
        await waitForDefaultDesktopResize();
    });

    it('keeps the surviving panel size when another owner panel closes', async () => {
        screen.giveToPerson();
        const firstPanel = await connectAndRequestPortraitResize({ width: 400, height: 800 });
        const secondPanel = await connectAndRequestPortraitResize({ width: 500, height: 1000 });

        receivedVncBytes = [];

        await new Promise<void>((resolve) => {
            firstPanel.once('close', () => {
                resolve();
            });
            firstPanel.close();
        });

        expect(receivedVncBytes)
            .toHaveLength(0);

        secondPanel.close();
        await waitForDefaultDesktopResize();
    });
});
