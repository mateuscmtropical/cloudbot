import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { SESSION_COOKIE_NAME } from '../access/requireSession.ts';
import type { SetupAccess } from '../access/SetupAccess.ts';

interface VncProxyOptions {
    server: Server;
    access: SetupAccess;
    vncPort?: number;
}

const VNC_PATH = '/api/desktop/vnc';
// x11vnc listens on localhost only. See docker/cloudbot-desktop.
const VNC_HOST = '127.0.0.1';
const DEFAULT_VNC_PORT = 5900;
// A slow browser must not make the server queue screen updates without limit.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 50;

function readCookie(request: IncomingMessage, cookieName: string): string | undefined {
    const cookieHeader = request.headers.cookie ?? '';
    const cookieEntries = cookieHeader.split(';')
        .map(entry => entry.trim());
    const prefix = `${cookieName}=`;
    const sessionEntry = cookieEntries.find(entry => entry.startsWith(prefix));

    return sessionEntry?.slice(prefix.length);
}

function refuse(socket: Duplex, statusLine: string): void {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function resumeWhenDrained(webSocket: WebSocket, vncSocket: Socket): void {
    const timer = setInterval(() => {
        const isGone = webSocket.readyState !== webSocket.OPEN || vncSocket.destroyed;

        if (isGone || webSocket.bufferedAmount <= MAX_BUFFERED_BYTES) {
            clearInterval(timer);
            vncSocket.resume();
        }
    }, RESUME_CHECK_MS);
}

// Binary frames in, raw RFB bytes out, and the other way round. noVNC speaks WebSocket, x11vnc speaks TCP.
function bridgeToVnc(webSocket: WebSocket, vncPort: number): void {
    const vncSocket = connect({ host: VNC_HOST, port: vncPort });

    vncSocket.on('data', (chunk: Buffer) => {
        webSocket.send(chunk);

        if (webSocket.bufferedAmount > MAX_BUFFERED_BYTES) {
            vncSocket.pause();
            resumeWhenDrained(webSocket, vncSocket);
        }
    });
    vncSocket.on('close', () => {
        webSocket.close();
    });
    // The desktop may be down or restarting. The panel shows a disconnected state.
    vncSocket.on('error', () => {
        webSocket.close();
    });
    webSocket.on('message', (data: Buffer) => {
        vncSocket.write(data);
    });
    webSocket.on('close', () => {
        vncSocket.destroy();
    });
    webSocket.on('error', () => {
        vncSocket.destroy();
    });
}

function attachVncProxy(options: VncProxyOptions): void {
    const vncPort = options.vncPort ?? DEFAULT_VNC_PORT;
    const webSocketServer = new WebSocketServer({ noServer: true });

    options.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        // Node removes its own error listener before this event. A reset during the session lookup would crash the server.
        socket.on('error', () => {
            socket.destroy();
        });

        const requestPath = (request.url ?? '').split('?')[0];

        if (requestPath !== VNC_PATH) {
            // Other upgrade paths are not served.
            refuse(socket, '404 Not Found');

            return;
        }

        const sessionToken = readCookie(request, SESSION_COOKIE_NAME);

        options.access.isValidSession(sessionToken)
            .then((isValid) => {
                if (!isValid) {
                    refuse(socket, '401 Unauthorized');

                    return;
                }

                webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                    bridgeToVnc(webSocket, vncPort);
                });
            })
            .catch(() => {
                refuse(socket, '500 Internal Server Error');
            });
    });
}

export { attachVncProxy, VNC_PATH };
export type { VncProxyOptions };
