import { connect } from 'node:net';
import type { IncomingMessage, Server, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';

import { HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import type { ActivityTracker, InstanceManager, PeopleStore, PersonRecord } from '../contract.ts';
import type { LoginSessions } from '../auth/LoginSessions.ts';
import { readHostRoute } from '../auth/hostRouting.ts';
import { HUB_SESSION_COOKIE, readHubSessionCookie } from '../auth/sessionCookie.ts';
import type { UpstreamTarget } from '../auth/createFrontDoorRoutes.ts';

interface UpgradeProxyOptions {
    server: Server;
    people: PeopleStore;
    sessions: LoginSessions;
    instances: InstanceManager;
    activity: ActivityTracker;
    domain: string;
    upstreamFor?: (name: string) => UpstreamTarget;
}

const DEFAULT_UPSTREAM_PORT = 3000;
const FORWARDED_PROTO = 'https';
const LOCAL_FORWARDED_PROTO = 'http';
const HOP_BY_HOP_HEADERS = new Set(['keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding']);

function refuse(socket: Duplex, statusLine: string): void {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function readForwardedFor(request: IncomingMessage): string {
    const forwardedFor = request.headers['x-forwarded-for'];

    if (typeof forwardedFor === 'string' && forwardedFor !== '') {
        return forwardedFor;
    }

    return request.socket.remoteAddress ?? 'unknown';
}

function removeSessionCookie(cookieHeader: string | undefined): string | undefined {
    if (cookieHeader === undefined) {
        return undefined;
    }

    const keptCookies = cookieHeader.split(';')
        .map(entry => entry.trim())
        .filter(entry => entry !== '' && !entry.startsWith(`${HUB_SESSION_COOKIE}=`));

    return keptCookies.length === 0 ? undefined : keptCookies.join('; ');
}

function readConnectionTokens(request: IncomingMessage): Set<string> {
    const rawConnection = request.headers.connection ?? '';
    const connection = Array.isArray(rawConnection) ? rawConnection.join(',') : rawConnection;
    const tokens = connection.split(',')
        .map(token => token.trim()
            .toLowerCase())
        .filter(token => token !== '');

    return new Set(tokens);
}

function buildUpgradeHeaders(request: IncomingMessage, person: PersonRecord, secure: boolean): OutgoingHttpHeaders {
    const forwardedHeaders: OutgoingHttpHeaders = {};
    const connectionTokens = readConnectionTokens(request);

    Object.entries(request.headers)
        .forEach(([name, value]) => {
            if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name) || name === HUB_TRUST_HEADER || name === 'cookie' || name === 'connection' || name === 'upgrade') {
                return;
            }

            forwardedHeaders[name] = value;
        });

    const cookieHeader = removeSessionCookie(request.headers.cookie);

    if (cookieHeader !== undefined) {
        forwardedHeaders.cookie = cookieHeader;
    }

    forwardedHeaders.host = request.headers.host ?? '';
    forwardedHeaders.connection = 'Upgrade';
    forwardedHeaders.upgrade = 'websocket';
    forwardedHeaders[HUB_TRUST_HEADER] = person.instanceSecret;
    forwardedHeaders['x-forwarded-for'] = readForwardedFor(request);
    forwardedHeaders['x-forwarded-proto'] = secure ? FORWARDED_PROTO : LOCAL_FORWARDED_PROTO;

    return forwardedHeaders;
}

function formatHeaderLines(headers: OutgoingHttpHeaders): string {
    const lines: string[] = [];

    Object.entries(headers)
        .forEach(([name, value]) => {
            if (value === undefined) {
                return;
            }

            if (Array.isArray(value)) {
                value.forEach((entry) => {
                    lines.push(`${name}: ${entry}\r\n`);
                });

                return;
            }

            const headerValue = typeof value === 'number' ? value.toString() : value;

            lines.push(`${name}: ${headerValue}\r\n`);
        });

    return lines.join('');
}

function isSameOriginUpgrade(request: IncomingMessage, host: string, secure: boolean): boolean {
    const origin = request.headers.origin;

    if (origin === undefined) {
        return true;
    }

    try {
        const originUrl = new URL(origin);
        const expectedProtocol = secure ? 'https:' : 'http:';

        return originUrl.host.toLowerCase() === host.toLowerCase() && originUrl.protocol === expectedProtocol;
    } catch {
        return false;
    }
}

function closeActivityOnce(name: string, activity: ActivityTracker): () => void {
    let isClosed = false;

    return () => {
        if (!isClosed) {
            isClosed = true;
            activity.closed(name);
        }
    };
}

function connectToInstance(request: IncomingMessage, clientSocket: Duplex, head: Buffer, person: PersonRecord, options: UpgradeProxyOptions, secure: boolean): void {
    const target = options.upstreamFor?.(person.name);
    const hostname = target?.hostname ?? `cloudbot-i-${person.name}`;
    const port = target?.port ?? DEFAULT_UPSTREAM_PORT;
    const upstreamSocket = connect({ host: hostname, port });
    const markClosed = closeActivityOnce(person.name, options.activity);
    let isConnected = false;

    clientSocket.once('close', () => {
        upstreamSocket.destroy();

        if (isConnected) {
            markClosed();
        }
    });
    clientSocket.once('end', () => {
        upstreamSocket.destroy();

        if (isConnected) {
            markClosed();
        }
    });
    clientSocket.once('error', () => {
        upstreamSocket.destroy();

        if (isConnected) {
            markClosed();
        }
    });
    upstreamSocket.once('connect', () => {
        isConnected = true;
        options.activity.opened(person.name);
        const path = request.url ?? '/';
        const method = request.method ?? 'GET';
        const version = request.httpVersion;
        const headers = buildUpgradeHeaders(request, person, secure);
        const headerLines = formatHeaderLines(headers);
        const requestHead = `${method} ${path} HTTP/${version}\r\n${headerLines}\r\n`;

        upstreamSocket.write(requestHead);

        if (head.length > 0) {
            upstreamSocket.write(head);
        }

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once('end', () => {
        if (isConnected) {
            markClosed();
        }
    });
    upstreamSocket.once('close', () => {
        if (isConnected) {
            markClosed();
        }
    });
    upstreamSocket.once('error', () => {
        if (!isConnected && !clientSocket.destroyed) {
            refuse(clientSocket, '502 Bad Gateway');
        } else {
            clientSocket.destroy();
        }

        if (isConnected) {
            markClosed();
        }
    });
}

function attachUpgradeProxy(options: UpgradeProxyOptions): void {
    options.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        socket.on('error', () => {
            socket.destroy();
        });

        const hostHeader = request.headers.host;
        const hostRoute = readHostRoute(hostHeader, options.domain);

        if (hostHeader === undefined || hostRoute === undefined || hostRoute.isApex || hostRoute.name === undefined) {
            refuse(socket, '404 Not Found');

            return;
        }

        const person = options.people.find(hostRoute.name);

        if (person === undefined || person.state !== 'active') {
            refuse(socket, '404 Not Found');

            return;
        }

        const sessionToken = readHubSessionCookie(request);
        const currentTime = Date.now();
        const sessionName = sessionToken === undefined ? undefined : options.sessions.find(sessionToken, currentTime);

        if (sessionName === undefined || sessionName !== person.name) {
            refuse(socket, '401 Unauthorized');

            return;
        }

        const secure = options.domain.toLowerCase() !== 'localhost';

        if (!isSameOriginUpgrade(request, hostHeader, secure)) {
            refuse(socket, '403 Forbidden');

            return;
        }

        options.instances.status(person.name)
            .then((status) => {
                if (status !== 'running') {
                    const start = options.instances.start(person.name);

                    void start.catch(() => undefined);
                    refuse(socket, '503 Service Unavailable');

                    return;
                }

                options.activity.touch(person.name);
                connectToInstance(request, socket, head, person, options, secure);
            })
            .catch(() => {
                refuse(socket, '502 Bad Gateway');
            });
    });
}

export { attachUpgradeProxy, buildUpgradeHeaders, readForwardedFor };
export type { UpgradeProxyOptions };
