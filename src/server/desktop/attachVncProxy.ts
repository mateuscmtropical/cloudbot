import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { isValidHubSecret } from '../access/hubSession.ts';
import { SESSION_COOKIE_NAME } from '../access/requireSession.ts';
import type { SetupAccess } from '../access/SetupAccess.ts';
import { DesktopResizeCoordinator } from './DesktopResizeCoordinator.ts';
import { RfbInputFilter } from './RfbInputFilter.ts';
import type { ScreenHolder } from './ScreenHolder.ts';

interface VncProxyOptions {
    server: Server;
    access: SetupAccess;
    hubSecret?: string | undefined;
    // Mouse and keyboard reach the desktop only while a person holds the screen.
    screen: ScreenHolder;
    vncPort?: number;
    publicUrl?: string | undefined;
}

const VNC_PATH = '/api/desktop/vnc';
// TigerVNC listens on localhost only. See docker/cloudbot-desktop.
const VNC_HOST = '127.0.0.1';
const DEFAULT_VNC_PORT = 5900;
// A slow browser must not make the server queue screen updates without limit.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 50;
// RFB input messages are tiny. The ws default of 100 MB would let a client make the server buffer a lot.
const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;

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

// The host of the public address, when one is set and valid. The owner may open the panel on that address.
function readPublicHost(publicUrl: string | undefined): string | undefined {
    if (publicUrl === undefined || publicUrl === '') {
        return undefined;
    }

    try {
        return new URL(publicUrl).host.toLowerCase();
    } catch {
        return undefined;
    }
}

// The session cookie does not tell localhost ports apart, so a page of another port could open the socket.
// Only a page from this server's own host, or the host of the public address, passes. A request without an Origin is refused.
function isOwnOrigin(request: IncomingMessage, publicHost: string | undefined): boolean {
    const origin = request.headers.origin;
    const host = request.headers.host;

    if (origin === undefined || host === undefined) {
        return false;
    }

    try {
        const originHost = new URL(origin).host;

        return originHost === host.toLowerCase() || originHost === publicHost;
    } catch {
        return false;
    }
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

// Binary frames in, raw RFB bytes out, and the other way round. noVNC speaks WebSocket, TigerVNC speaks TCP.
function bridgeToVnc(webSocket: WebSocket, vncPort: number, screen: ScreenHolder, resizeCoordinator: DesktopResizeCoordinator): void {
    const vncSocket = connect({ host: VNC_HOST, port: vncPort });
    const resizeOwner = {};
    const inputFilter = new RfbInputFilter(
        () => screen.isPersonHolding,
        (size) => {
            resizeCoordinator.request(resizeOwner, vncSocket, size);
        },
    );
    const stopListening = screen.onChange((isPersonHolding) => {
        if (!isPersonHolding) {
            resizeCoordinator.restoreAll(vncSocket);
        }
    });

    function closeBridge(): void {
        stopListening();
        const didQueueDefaultSize = resizeCoordinator.release(resizeOwner, vncSocket);

        if (didQueueDefaultSize || vncSocket.destroyed || vncSocket.writableEnded) {
            return;
        }

        vncSocket.end();
    }

    vncSocket.on('data', (chunk: Buffer) => {
        if (webSocket.readyState === webSocket.OPEN) {
            webSocket.send(chunk);
        }

        if (webSocket.bufferedAmount > MAX_BUFFERED_BYTES && !vncSocket.isPaused()) {
            vncSocket.pause();
            resumeWhenDrained(webSocket, vncSocket);
        }
    });
    vncSocket.on('close', () => {
        stopListening();
        webSocket.close();
    });
    // The desktop may be down or restarting. The panel shows a disconnected state.
    vncSocket.on('error', () => {
        stopListening();
        webSocket.close();
    });
    webSocket.on('message', (data: Buffer) => {
        try {
            const allowed = inputFilter.filter(data);

            if (allowed.length > 0) {
                vncSocket.write(allowed);
            }
        } catch {
            // A stream that cannot be framed could carry input the filter cannot see.
            const didQueueDefaultSize = resizeCoordinator.release(resizeOwner, vncSocket);

            webSocket.close();

            if (!didQueueDefaultSize && !vncSocket.destroyed && !vncSocket.writableEnded) {
                vncSocket.destroy();
            }
        }
    });
    webSocket.on('close', () => {
        closeBridge();
    });
    webSocket.on('error', () => {
        closeBridge();
    });
}

interface SessionSocketOptions {
    server: Server;
    access: SetupAccess;
    hubSecret?: string | undefined;
    // The only upgrade path this socket serves. Other paths get a 404.
    path: string;
    accept: (webSocket: WebSocket) => void;
    // CLOUDBOT_PUBLIC_URL, when set. Its host may open the socket too.
    publicUrl?: string | undefined;
}

// Upgrades one path for a signed-in owner only. The desktop views share it.
function attachSessionSocket(options: SessionSocketOptions): void {
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES });
    const publicHost = readPublicHost(options.publicUrl);

    options.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        // Node removes its own error listener before this event. A reset during the session lookup would crash the server.
        socket.on('error', () => {
            socket.destroy();
        });

        const requestPath = (request.url ?? '').split('?')[0];

        if (requestPath !== options.path) {
            // Other upgrade paths are not served.
            refuse(socket, '404 Not Found');

            return;
        }

        if (!isOwnOrigin(request, publicHost)) {
            refuse(socket, '403 Forbidden');

            return;
        }

        const sessionToken = readCookie(request, SESSION_COOKIE_NAME);
        const hubSecret = request.headers[HUB_TRUST_HEADER];
        const hubSecretValue = typeof hubSecret === 'string' ? hubSecret : undefined;
        const isHubSession = isValidHubSecret(hubSecretValue, options.hubSecret);

        const sessionCheck = isHubSession ? Promise.resolve(true) : options.access.isValidSession(sessionToken);

        sessionCheck
            .then((isValid) => {
                if (!isValid) {
                    refuse(socket, '401 Unauthorized');

                    return;
                }

                webSocketServer.handleUpgrade(request, socket, head, options.accept);
            })
            .catch(() => {
                refuse(socket, '500 Internal Server Error');
            });
    });
}

function attachVncProxy(options: VncProxyOptions): void {
    const vncPort = options.vncPort ?? DEFAULT_VNC_PORT;
    const resizeCoordinator = new DesktopResizeCoordinator();

    attachSessionSocket({
        server: options.server,
        access: options.access,
        hubSecret: options.hubSecret,
        path: VNC_PATH,
        publicUrl: options.publicUrl,
        accept: (webSocket) => {
            bridgeToVnc(webSocket, vncPort, options.screen, resizeCoordinator);
        },
    });
}

export { MAX_CLIENT_MESSAGE_BYTES, attachSessionSocket, attachVncProxy, readCookie, refuse, VNC_PATH };
export type { SessionSocketOptions, VncProxyOptions };
