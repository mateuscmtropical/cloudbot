import { createServer as createTcpServer } from 'node:net';
import type { Server as TcpServer } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SetupAccess } from '../access/SetupAccess.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { SettingsStore } from '../store/SettingsStore.ts';
import { attachVncProxy } from './attachVncProxy.ts';

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

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        access = new SetupAccess(new SettingsStore(opened.db));
        vncServer = createTcpServer((connection) => {
            connection.write('RFB 003.008\n');
            connection.on('data', (chunk) => {
                connection.write(chunk);
            });
        });

        const vncPort = await listenOnFreePort(vncServer);

        httpServer = createServer();
        attachVncProxy({ server: httpServer, access, vncPort });
        httpPort = await listenOnFreePort(httpServer);

        const setupCode = await access.issueSetupCode();
        const redeemedToken = await access.redeemSetupCode(setupCode);

        if (redeemedToken === undefined) {
            throw new Error('The setup code was not accepted.');
        }

        sessionToken = redeemedToken;
    });

    afterEach(() => {
        httpServer.closeAllConnections();
        httpServer.close();
        vncServer.close();
        opened.close();
    });

    it('refuses a request without the session cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`);

        expect(await waitForOutcome(webSocket))
            .toBe('status:401');
    });

    it('refuses a request with a wrong session cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: 'cloudbot_session=wrong' },
        });

        expect(await waitForOutcome(webSocket))
            .toBe('status:401');
    });

    it('forwards the VNC greeting and the client bytes with a valid cookie', async () => {
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(httpPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}` },
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

    it('closes the socket when the desktop is not running', async () => {
        vncServer.close();
        httpServer.closeAllConnections();

        const deadVncPort = await listenOnFreePort(createTcpServer());
        const secondServer = createServer();

        attachVncProxy({ server: secondServer, access, vncPort: deadVncPort + 1 });

        const secondPort = await listenOnFreePort(secondServer);
        const webSocket = new WebSocket(`ws://127.0.0.1:${String(secondPort)}/api/desktop/vnc`, {
            headers: { cookie: `cloudbot_session=${sessionToken}` },
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
});
