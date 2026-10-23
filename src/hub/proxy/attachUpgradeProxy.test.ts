import { createHash } from 'node:crypto';
import { request, createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ActivityTracker, InstanceManager, PeopleStore, PersonRecord, StartResult } from '../contract.ts';
import type { InstanceStatus } from '../../shared/peopleTypes.ts';
import type { UpstreamTarget } from '../auth/createFrontDoorRoutes.ts';
import { createLoginSessionTables, SqliteLoginSessions } from '../auth/LoginSessions.ts';
import { attachUpgradeProxy } from './attachUpgradeProxy.ts';
import type { UpgradeProxyOptions } from './attachUpgradeProxy.ts';

interface UpgradeHarness {
    server: Server;
    database: DatabaseSync;
    sessions: SqliteLoginSessions;
    activity: FakeActivity;
}

interface ObservedUpgrade {
    host: string;
    hubSecret: string;
    cookie: string;
    forwardedFor: string;
    forwardedProto: string;
    browserHubHeader: string;
    upgrade: string;
    connection: string;
    removedHeader: string;
}

interface UpgradeResult {
    responseStatus: number;
    socket: Socket;
}

class FakePeople implements PeopleStore {
    private readonly person: PersonRecord;

    constructor(person: PersonRecord) {
        this.person = person;
    }

    list(): PersonRecord[] {
        return [this.person];
    }

    find(name: string): PersonRecord | undefined {
        return name === this.person.name ? this.person : undefined;
    }

    add(): void {}

    update(): void {}

    remove(): void {}
}

class FakeInstances implements InstanceManager {
    status(): Promise<InstanceStatus> {
        return Promise.resolve('running');
    }

    create(): Promise<void> {
        return Promise.resolve();
    }

    start(): Promise<StartResult> {
        return Promise.resolve('running');
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    remove(): Promise<void> {
        return Promise.resolve();
    }
}

class FakeActivity implements ActivityTracker {
    touches: string[] = [];
    openedConnections: string[] = [];
    closedConnections: string[] = [];

    touch(name: string): void {
        this.touches.push(name);
    }

    opened(name: string): void {
        this.openedConnections.push(name);
    }

    closed(name: string): void {
        this.closedConnections.push(name);
    }
}

const PERSON_NAME = 'maria';
const PERSON_SECRET = 'secret-for-maria';

async function startServer(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The local server did not get a TCP address.');
    }

    return address.port;
}

async function stopServer(server: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error !== undefined) {
                reject(error);

                return;
            }

            resolve();
        });
    });
}

function makeUpgradeResponse(request: IncomingMessage, socket: Duplex): void {
    const websocketKey = request.headers['sec-websocket-key'] ?? '';
    const acceptValue = createHash('sha1')
        .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');
    const response = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptValue}\r\n\r\n`;

    socket.write(response);
    socket.on('data', (chunk: Buffer) => {
        socket.write(chunk);
    });
}

function readHeaderValue(value: string | string[] | undefined): string {
    if (typeof value === 'string') {
        return value;
    }

    return value?.join(',') ?? '';
}

function readObservedUpgrade(request: IncomingMessage): ObservedUpgrade {
    return {
        host: readHeaderValue(request.headers.host),
        hubSecret: readHeaderValue(request.headers['x-cloudbot-hub']),
        cookie: readHeaderValue(request.headers.cookie),
        forwardedFor: readHeaderValue(request.headers['x-forwarded-for']),
        forwardedProto: readHeaderValue(request.headers['x-forwarded-proto']),
        browserHubHeader: readHeaderValue(request.headers['x-browser-hub-value']),
        upgrade: readHeaderValue(request.headers.upgrade),
        connection: readHeaderValue(request.headers.connection),
        removedHeader: readHeaderValue(request.headers['x-remove-me']),
    };
}

function createHarness(target: UpstreamTarget): UpgradeHarness {
    const database = new DatabaseSync(':memory:');

    createLoginSessionTables(database);
    const sessions = new SqliteLoginSessions(database);
    const person: PersonRecord = {
        name: PERSON_NAME,
        role: 'member',
        state: 'active',
        passwordHash: 'unused',
        mustChangePassword: false,
        instanceSecret: PERSON_SECRET,
        createdAt: 0,
        lastSeenAt: null,
    };
    const people = new FakePeople(person);
    const instances = new FakeInstances();
    const activity = new FakeActivity();
    const server = createServer();
    const options: UpgradeProxyOptions = {
        server,
        people,
        sessions,
        instances,
        activity,
        domain: 'localhost',
        upstreamFor: () => target,
    };

    attachUpgradeProxy(options);

    return { server, database, sessions, activity };
}

function makeWebSocketKey(): string {
    return 'dGhlIHNhbXBsZSBub25jZQ==';
}

function closeWebSocket(socket: Socket): Promise<void> {
    return new Promise((resolve) => {
        socket.once('close', resolve);
        socket.destroy();
    });
}

async function waitForActivityClose(activity: FakeActivity, attemptsLeft = 50): Promise<void> {
    if (activity.closedConnections.length > 0) {
        return;
    }

    if (attemptsLeft === 0) {
        throw new Error('The proxy did not close its activity connection.');
    }

    await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
    });
    await waitForActivityClose(activity, attemptsLeft - 1);
}

describe('attachUpgradeProxy', () => {
    let servers: Server[] = [];
    let databases: DatabaseSync[] = [];
    let sockets: Duplex[] = [];

    beforeEach(() => {
        servers = [];
        databases = [];
        sockets = [];
    });

    afterEach(async () => {
        sockets.forEach((socket) => {
            socket.destroy();
        });
        await Promise.all(servers.map(stopServer));
        databases.forEach((database) => {
            database.close();
        });
    });

    it('forwards a signed in upgrade with the trusted secret and streams both ways', async () => {
        let observed: ObservedUpgrade | undefined;
        const upstream = createServer();

        upstream.on('upgrade', (incomingRequest, socket) => {
            sockets.push(socket);
            observed = readObservedUpgrade(incomingRequest);
            makeUpgradeResponse(incomingRequest, socket);
        });

        const upstreamPort = await startServer(upstream);

        servers.push(upstream);
        const harness = createHarness({ hostname: '127.0.0.1', port: upstreamPort });

        harness.server.on('connection', (socket) => {
            sockets.push(socket);
        });
        const sessions = harness.sessions;
        const sessionToken = sessions.create(PERSON_NAME, Date.now());
        const proxyPort = await startServer(harness.server);

        servers.push(harness.server);
        databases.push(harness.database);
        const origin = `http://maria.localhost:${String(proxyPort)}`;
        const upgradePromise = new Promise<UpgradeResult>((resolve, reject) => {
            const outgoingRequest = request({
                host: '127.0.0.1',
                port: proxyPort,
                path: '/api/desktop/screencast',
                headers: {
                    'host': `maria.localhost:${String(proxyPort)}`,
                    origin,
                    'cookie': `cloudbot_hub_session=${sessionToken}; theme=blue`,
                    'connection': 'Upgrade, x-remove-me',
                    'x-remove-me': 'drop',
                    'upgrade': 'websocket',
                    'sec-websocket-key': makeWebSocketKey(),
                    'sec-websocket-version': '13',
                    'x-cloudbot-hub': 'browser-secret',
                    'x-browser-hub-value': 'kept',
                    'x-forwarded-for': '198.51.100.23',
                },
            });

            outgoingRequest.once('upgrade', (response, socket) => {
                resolve({ responseStatus: response.statusCode ?? 0, socket });
            });
            outgoingRequest.once('response', (response) => {
                reject(new Error(`The upgrade was refused with ${String(response.statusCode)}.`));
            });
            outgoingRequest.once('error', reject);
            outgoingRequest.end();
        });
        const upgrade = await upgradePromise;

        expect(upgrade.responseStatus)
            .toBe(101);
        expect(observed?.host)
            .toBe(`maria.localhost:${String(proxyPort)}`);
        expect(observed?.hubSecret)
            .toBe(PERSON_SECRET);
        expect(observed?.browserHubHeader)
            .toBe('kept');
        expect(observed?.cookie)
            .toBe('theme=blue');
        expect(observed?.forwardedFor)
            .toBe('198.51.100.23');
        expect(observed?.forwardedProto)
            .toBe('http');
        expect(observed?.upgrade)
            .toBe('websocket');
        expect(observed?.connection)
            .toBe('Upgrade');
        expect(observed?.removedHeader)
            .toBe('');
        expect(harness.activity.touches)
            .toEqual([PERSON_NAME]);
        expect(harness.activity.openedConnections)
            .toEqual([PERSON_NAME]);

        const echoedFrame = new Promise<string>((resolve) => {
            upgrade.socket.once('data', (chunk: Buffer) => {
                resolve(chunk.toString());
            });
        });

        upgrade.socket.write('frame-data');
        const echoedText = await echoedFrame;

        expect(echoedText)
            .toBe('frame-data');

        const closed = closeWebSocket(upgrade.socket);

        await closed;
        await waitForActivityClose(harness.activity);
        expect(harness.activity.closedConnections)
            .toEqual([PERSON_NAME]);
    });

    it('refuses an upgrade without a matching host session', async () => {
        const upstream = createServer();
        const upstreamPort = await startServer(upstream);

        servers.push(upstream);
        const harness = createHarness({ hostname: '127.0.0.1', port: upstreamPort });

        harness.server.on('connection', (socket) => {
            sockets.push(socket);
        });
        const proxyPort = await startServer(harness.server);

        servers.push(harness.server);
        databases.push(harness.database);
        const responseStatus = await new Promise<number>((resolve, reject) => {
            const outgoingRequest = request({
                host: '127.0.0.1',
                port: proxyPort,
                path: '/api/desktop/vnc',
                headers: {
                    host: `maria.localhost:${String(proxyPort)}`,
                    connection: 'Upgrade',
                    upgrade: 'websocket',
                },
            });

            outgoingRequest.once('response', (response) => {
                resolve(response.statusCode ?? 0);
            });
            outgoingRequest.once('error', reject);
            outgoingRequest.end();
        });

        expect(responseStatus)
            .toBe(401);
        expect(harness.activity.touches)
            .toEqual([]);
    });
});

export {};
