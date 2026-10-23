import { createHash } from 'node:crypto';
import { request as httpRequest, createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';

import type { InstanceManager, PersonRecord, StartResult } from './contract.ts';
import type { InstanceStatus } from '../shared/peopleTypes.ts';
import { INSTANCE_NAME_HEADER, INSTANCE_SECRET_HEADER } from '../shared/hubProtocol.ts';
import { createHubApp } from './createHubApp.ts';
import { createLoginSessionTables, SqliteLoginSessions } from './auth/LoginSessions.ts';
import { createIdleWatcher } from './idle/IdleWatcher.ts';
import type { UpstreamTarget } from './auth/createFrontDoorRoutes.ts';
import { openHubDatabase } from './store/openHubDatabase.ts';
import { SqlitePeopleStore } from './store/SqlitePeopleStore.ts';
import { hashPassword } from './passwords.ts';
import { createHubPasskeyTables, SqliteHubPasskeyStore } from './passkeys/HubPasskeyStore.ts';
import { HubPasskeyService } from './passkeys/HubPasskeyService.ts';
import { attachUpgradeProxy } from './proxy/attachUpgradeProxy.ts';

interface ObservedRequest {
    path: string;
    host: string;
    hubSecret: string;
    cookie: string;
}

interface TestResponse {
    status: number;
    headers: IncomingMessage['headers'];
    body: string;
}

interface HubHarness {
    database: ReturnType<typeof openHubDatabase>;
    people: SqlitePeopleStore;
    instances: FakeInstances;
    sessions: SqliteLoginSessions;
    watcher: ReturnType<typeof createIdleWatcher>;
    hubServer: Server;
    hubPort: number;
    instanceServers: Server[];
    instanceTargets: Map<string, UpstreamTarget>;
    observations: Map<string, ObservedRequest[]>;
    upgraded: Map<string, ObservedRequest[]>;
    sockets: Array<{ destroy: () => void }>;
}

class FakeInstances implements InstanceManager {
    private readonly statuses = new Map<string, InstanceStatus>();
    readonly stoppedNames: string[] = [];

    constructor(names: string[]) {
        names.forEach(name => this.statuses.set(name, 'running'));
    }

    status(name: string): Promise<InstanceStatus> {
        return Promise.resolve(this.statuses.get(name) ?? 'missing');
    }

    create(): Promise<void> {
        return Promise.resolve();
    }

    start(name: string): Promise<StartResult> {
        this.statuses.set(name, 'running');

        return Promise.resolve('running');
    }

    stop(name: string): Promise<void> {
        this.statuses.set(name, 'stopped');
        this.stoppedNames.push(name);

        return Promise.resolve();
    }

    remove(name: string): Promise<void> {
        this.statuses.delete(name);

        return Promise.resolve();
    }

    setStatus(name: string, status: InstanceStatus): void {
        this.statuses.set(name, status);
    }
}

function makeRecord(name: string, role: 'owner' | 'member', passwordHash: string): PersonRecord {
    return {
        name,
        role,
        state: 'active',
        passwordHash,
        mustChangePassword: false,
        instanceSecret: `${name}-instance-secret`,
        createdAt: Date.now(),
        lastSeenAt: null,
    };
}

function readHeader(request: IncomingMessage, name: string): string {
    const value = request.headers[name];

    return typeof value === 'string' ? value : Array.isArray(value) ? value.join(',') : '';
}

function recordUpgradeResponse(request: IncomingMessage, socket: Duplex): void {
    const websocketKey = readHeader(request, 'sec-websocket-key');
    const acceptValue = createHash('sha1')
        .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');

    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptValue}\r\n\r\n`);
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The test server did not get a TCP address.');
    }

    return address.port;
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) {
        return;
    }

    server.closeAllConnections();
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

function sendRequest(port: number, host: string, path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<TestResponse> {
    return new Promise((resolve, reject) => {
        const outgoingRequest = httpRequest({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: { host, ...headers },
        }, (incomingResponse) => {
            const chunks: Buffer[] = [];

            incomingResponse.on('data', (chunk: Buffer) => chunks.push(chunk));
            incomingResponse.once('end', () => {
                resolve({
                    status: incomingResponse.statusCode ?? 0,
                    headers: incomingResponse.headers,
                    body: Buffer.concat(chunks)
                        .toString(),
                });
            });
        });

        outgoingRequest.once('error', reject);

        if (body === undefined) {
            outgoingRequest.end();
        } else {
            outgoingRequest.end(body);
        }
    });
}

function cookieFrom(response: TestResponse): string {
    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const token = /cloudbot_hub_session=([^;]+)/.exec(cookieHeader ?? '')?.[1];

    if (token === undefined) {
        throw new Error('Password sign-in did not set a hub session cookie.');
    }

    return `cloudbot_hub_session=${token}`;
}

async function passwordLoginResponse(harness: HubHarness, name: string, offerCookie?: string): Promise<TestResponse> {
    const host = `${name}.localhost:${String(harness.hubPort)}`;
    const password = name === 'maria' ? 'maria test password' : 'joao test password';
    const body = new URLSearchParams({ password })
        .toString();
    const headers = {
        'origin': `http://${host}`,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
    };

    return sendRequest(harness.hubPort, host, '/__hub/login', 'POST', offerCookie === undefined ? headers : { ...headers, cookie: offerCookie }, body);
}

async function login(harness: HubHarness, name: string): Promise<string> {
    const response = await passwordLoginResponse(harness, name);

    expect(response.status)
        .toBe(303);

    return cookieFrom(response);
}

async function createHarness(): Promise<HubHarness> {
    const database = openHubDatabase(':memory:');
    const people = new SqlitePeopleStore(database);
    const mariaHash = await hashPassword('maria test password');
    const joaoHash = await hashPassword('joao test password');
    const ownerHash = await hashPassword('owner test password');

    people.add(makeRecord('owner', 'owner', ownerHash));
    people.add(makeRecord('maria', 'member', mariaHash));
    people.add(makeRecord('joao', 'member', joaoHash));
    createLoginSessionTables(database);
    createHubPasskeyTables(database);
    const sessions = new SqliteLoginSessions(database);
    const passkeyStore = new SqliteHubPasskeyStore(database);
    const passkeys = new HubPasskeyService({ store: passkeyStore, domain: 'localhost' });
    const instances = new FakeInstances(['owner', 'maria', 'joao']);
    const instanceTargets = new Map<string, UpstreamTarget>();
    const observations = new Map<string, ObservedRequest[]>();
    const upgraded = new Map<string, ObservedRequest[]>();
    const instanceServers: Server[] = [];
    const sockets: Array<{ destroy: () => void }> = [];

    const upstreams = await Promise.all(['maria', 'joao'].map(async (name) => {
        const server = createServer((request, response) => {
            const observed: ObservedRequest = {
                path: request.url ?? '/',
                host: readHeader(request, 'host'),
                hubSecret: readHeader(request, 'x-cloudbot-hub'),
                cookie: readHeader(request, 'cookie'),
            };

            observations.set(name, [...(observations.get(name) ?? []), observed]);
            const body = JSON.stringify(observed);

            response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
            response.end(body);
        });

        server.on('connection', socket => sockets.push(socket));
        server.on('upgrade', (request, socket) => {
            sockets.push(socket);
            const observed: ObservedRequest = {
                path: request.url ?? '/',
                host: readHeader(request, 'host'),
                hubSecret: readHeader(request, 'x-cloudbot-hub'),
                cookie: readHeader(request, 'cookie'),
            };

            upgraded.set(name, [...(upgraded.get(name) ?? []), observed]);
            recordUpgradeResponse(request, socket);
        });

        const upstreamPort = await listen(server);

        return { name, server, target: { hostname: '127.0.0.1', port: upstreamPort } };
    }));

    upstreams.forEach((upstream) => {
        instanceServers.push(upstream.server);
        instanceTargets.set(upstream.name, upstream.target);
    });

    const idleWatcher = createIdleWatcher({
        people,
        instances,
        fetchActivity: () => Promise.resolve({ isBusy: false, reasons: [] }),
        idleMs: 60,
        checkEveryMs: 10,
    });
    const app = createHubApp({
        people,
        instances,
        sessions,
        passkeys,
        passkeyStore,
        domain: 'localhost',
        secure: false,
        activity: idleWatcher,
        upstreamFor: (name) => {
            const target = instanceTargets.get(name);

            if (target === undefined) {
                throw new Error(`No test instance is configured for ${name}.`);
            }

            return target;
        },
    });
    const hubServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, () => undefined) as Server;

    hubServer.on('connection', socket => sockets.push(socket));

    attachUpgradeProxy({
        server: hubServer,
        people,
        sessions,
        instances,
        activity: idleWatcher,
        domain: 'localhost',
        upstreamFor: (name) => {
            const target = instanceTargets.get(name);

            if (target === undefined) {
                throw new Error(`No test instance is configured for ${name}.`);
            }

            return target;
        },
    });
    await once(hubServer, 'listening');
    const address = hubServer.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The test hub did not get a TCP address.');
    }

    return {
        database,
        people,
        instances,
        sessions,
        watcher: idleWatcher,
        hubServer,
        hubPort: address.port,
        instanceServers,
        instanceTargets,
        observations,
        upgraded,
        sockets,
    };
}

async function waitFor(predicate: () => boolean, message: string, deadline = Date.now() + 2_000): Promise<void> {
    if (predicate()) {
        return;
    }

    if (Date.now() >= deadline) {
        throw new Error(message);
    }

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    await waitFor(predicate, message, deadline);
}

describe('hub wiring', () => {
    let harness: HubHarness;

    beforeEach(async () => {
        harness = await createHarness();
    });

    afterEach(async () => {
        harness.watcher.stop();
        harness.sockets.forEach((socket) => {
            socket.destroy();
        });
        await Promise.all([closeServer(harness.hubServer), ...harness.instanceServers.map(closeServer)]);
        harness.database.close();
    });

    it('signs in by password and forwards only the instance cookie with the trust header', async () => {
        const cookie = await login(harness, 'maria');
        const host = `maria.localhost:${String(harness.hubPort)}`;
        const response = await sendRequest(harness.hubPort, host, '/api/echo', 'GET', { cookie: `${cookie}; theme=dark` });
        const observed = JSON.parse(response.body) as ObservedRequest;

        expect(response.status)
            .toBe(200);
        expect(observed.hubSecret)
            .toBe('maria-instance-secret');
        expect(observed.cookie)
            .toBe('theme=dark');
        expect(observed.host)
            .toBe(host);
    });

    it('offers passkey enrollment after password sign-in unless the offer cookie says skip', async () => {
        const offered = await passwordLoginResponse(harness, 'maria');
        const skipped = await passwordLoginResponse(harness, 'joao', 'cloudbot_passkey_offer=skip');
        const host = `maria.localhost:${String(harness.hubPort)}`;
        const offerPage = await sendRequest(harness.hubPort, host, '/__hub/passkey/offer', 'GET', { cookie: cookieFrom(offered) });

        expect(offered.headers.location)
            .toBe('/__hub/passkey/offer');
        expect(skipped.headers.location)
            .toBe('/');
        expect(offerPage.status)
            .toBe(200);
        expect(offerPage.body)
            .toContain('Turn on fingerprint or face for this device?');
    });

    it('does not let one person use another person’s session or instance', async () => {
        const joaoCookie = await login(harness, 'joao');
        const mariaHost = `maria.localhost:${String(harness.hubPort)}`;
        const response = await sendRequest(harness.hubPort, mariaHost, '/api/echo', 'GET', { cookie: joaoCookie });

        expect(response.status)
            .toBe(200);
        expect(response.body)
            .toContain('Sign in to CloudBot');
        expect(harness.observations.get('maria'))
            .toBeUndefined();
        expect(harness.observations.get('joao'))
            .toBeUndefined();
    });

    it('refuses a person who was deactivated after signing in', async () => {
        const cookie = await login(harness, 'maria');

        harness.people.update('maria', { state: 'inactive' });
        const host = `maria.localhost:${String(harness.hubPort)}`;
        const response = await sendRequest(harness.hubPort, host, '/', 'GET', { cookie });

        expect(response.status)
            .toBe(404);
        expect(response.body)
            .toContain('This address is not available.');
        expect(harness.observations.get('maria'))
            .toBeUndefined();
    });

    it('forwards a WebSocket upgrade to that person’s instance', async () => {
        const cookie = await login(harness, 'joao');
        const host = `joao.localhost:${String(harness.hubPort)}`;
        const origin = `http://${host}`;
        const upgrade = await new Promise<{ status: number; socket: Socket }>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timed out waiting for a proxied WebSocket upgrade.'));
            }, 2_000);
            const outgoingRequest = httpRequest({
                hostname: '127.0.0.1',
                port: harness.hubPort,
                path: '/api/desktop/screencast',
                headers: {
                    host,
                    origin,
                    cookie,
                    'connection': 'Upgrade',
                    'upgrade': 'websocket',
                    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
                    'sec-websocket-version': '13',
                },
            });

            outgoingRequest.once('upgrade', (response, socket) => {
                clearTimeout(timeout);
                resolve({ status: response.statusCode ?? 0, socket });
            });
            outgoingRequest.once('response', (response) => {
                clearTimeout(timeout);
                reject(new Error(`Upgrade refused with ${String(response.statusCode)}.`));
            });
            outgoingRequest.once('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });
            outgoingRequest.end();
        });

        harness.sockets.push(upgrade.socket);
        expect(upgrade.status)
            .toBe(101);
        expect(harness.upgraded.get('joao')?.[0])
            .toMatchObject({ host, hubSecret: 'joao-instance-secret', path: '/api/desktop/screencast' });
        upgrade.socket.destroy();
    });

    it('hides internal routes from public hosts and stops an idle instance', async () => {
        const publicHost = `maria.localhost:${String(harness.hubPort)}`;
        const publicResponse = await sendRequest(harness.hubPort, publicHost, '/internal/people', 'GET');
        const owner = harness.people.find('owner');

        expect(publicResponse.status)
            .toBe(404);
        if (owner === undefined) {
            throw new Error('Test owner is missing.');
        }

        const internalResponse = await sendRequest(harness.hubPort, 'hub:3001', '/internal/people', 'GET', {
            [INSTANCE_NAME_HEADER]: 'owner',
            [INSTANCE_SECRET_HEADER]: owner.instanceSecret,
        });

        expect(internalResponse.status)
            .toBe(200);
        harness.people.update('maria', { state: 'inactive' });
        harness.instances.setStatus('maria', 'stopped');
        harness.watcher.start();
        harness.watcher.touch('joao');
        await waitFor(() => harness.instances.stoppedNames.includes('joao'), 'Idle watcher did not stop Joao’s instance.');

        expect(harness.instances.stoppedNames)
            .toContain('joao');
    });
});
