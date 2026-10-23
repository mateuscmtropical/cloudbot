import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';

import type { ActivityTracker, InstanceManager, PersonRecord, PersonUpdate, StartResult } from '../contract.ts';
import type { InstanceStatus } from '../../shared/peopleTypes.ts';
import { hashPassword } from '../passwords.ts';
import { createFrontDoorRoutes } from './createFrontDoorRoutes.ts';
import type { FrontDoorRoutesOptions, UpstreamTarget } from './createFrontDoorRoutes.ts';
import { createLoginSessionTables, SqliteLoginSessions } from './LoginSessions.ts';

interface RouteOverrides {
    domain?: string;
    secure?: boolean;
    afterLogin?: (name: string) => string | undefined;
    upstreamFor?: (name: string) => UpstreamTarget;
}

interface TestHarness {
    app: Hono;
    database: DatabaseSync;
    people: FakePeople;
    instances: FakeInstances;
    activity: FakeActivity;
    now: () => number;
    advance: (milliseconds: number) => void;
}

interface LocalHttpServer {
    server: Server;
    target: UpstreamTarget;
}

interface ObservedHeaders {
    host: string;
    cookie: string;
    hubSecret: string;
    forwardedFor: string;
    forwardedProto: string;
    incomingHubHeader: string;
    connection: string;
    removedHeader: string;
}

const INITIAL_PASSWORD = 'correct horse battery staple';
const PERSON_NAME = 'maria';
const PERSON_SECRET = 'person-instance-secret';
const SESSION_TOKEN_PATTERN = /cloudbot_hub_session=([^;]+)/;

class FakePeople {
    private readonly records: Map<string, PersonRecord>;

    constructor(records: PersonRecord[]) {
        this.records = new Map(records.map(record => [record.name, record]));
    }

    find(name: string): PersonRecord | undefined {
        return this.records.get(name);
    }

    list(): PersonRecord[] {
        return Array.from(this.records.values());
    }

    add(record: PersonRecord): void {
        this.records.set(record.name, record);
    }

    update(name: string, update: PersonUpdate): void {
        const current = this.records.get(name);

        if (current !== undefined) {
            const updated = { ...current, ...update };

            this.records.set(name, updated);
        }
    }

    remove(name: string): void {
        this.records.delete(name);
    }
}

class FakeInstances implements InstanceManager {
    private readonly statuses = new Map<string, InstanceStatus>();
    startResult: StartResult = 'running';
    startCalls: string[] = [];

    status(name: string): Promise<InstanceStatus> {
        return Promise.resolve(this.statuses.get(name) ?? 'running');
    }

    setStatus(name: string, status: InstanceStatus): void {
        this.statuses.set(name, status);
    }

    create(): Promise<void> {
        return Promise.resolve();
    }

    start(name: string): Promise<StartResult> {
        this.startCalls.push(name);

        return Promise.resolve(this.startResult);
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

async function createHarness(overrides: RouteOverrides = {}, mustChangePassword = false): Promise<TestHarness> {
    const database = new DatabaseSync(':memory:');

    createLoginSessionTables(database);
    const sessions = new SqliteLoginSessions(database);
    const passwordHash = await hashPassword(INITIAL_PASSWORD);
    const person: PersonRecord = {
        name: PERSON_NAME,
        role: 'member',
        state: 'active',
        passwordHash,
        mustChangePassword,
        instanceSecret: PERSON_SECRET,
        createdAt: 0,
        lastSeenAt: null,
    };
    const people = new FakePeople([person]);
    const instances = new FakeInstances();
    const activity = new FakeActivity();
    let currentTime = 1_000;
    const now = (): number => currentTime;
    const advance = (milliseconds: number): void => {
        currentTime += milliseconds;
    };
    const routeOptions: FrontDoorRoutesOptions = {
        people,
        instances,
        sessions,
        domain: overrides.domain ?? 'example.test',
        secure: overrides.secure ?? true,
        activity,
        now,
        ...(overrides.afterLogin === undefined ? {} : { afterLogin: overrides.afterLogin }),
        ...(overrides.upstreamFor === undefined ? {} : { upstreamFor: overrides.upstreamFor }),
    };
    const app = createFrontDoorRoutes(routeOptions);

    return { app, database, people, instances, activity, now, advance };
}

function closeHarness(harness: TestHarness): void {
    harness.database.close();
}

async function login(app: Hono, password = INITIAL_PASSWORD, name = PERSON_NAME, forwardedFor = '203.0.113.8'): Promise<Response> {
    const body = new URLSearchParams({ password });
    const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'origin': `https://${name}.example.test`,
        'x-forwarded-for': forwardedFor,
    };

    return app.request(`https://${name}.example.test/__hub/login`, { method: 'POST', headers, body });
}

function cookieFrom(response: Response): string {
    const setCookie = response.headers.get('set-cookie') ?? '';
    const token = SESSION_TOKEN_PATTERN.exec(setCookie)?.[1];

    if (token === undefined) {
        throw new Error('Login did not set a hub session cookie.');
    }

    return `cloudbot_hub_session=${token}`;
}

async function startLocalServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalHttpServer> {
    const server = createServer(handler);

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The local upstream did not get a TCP address.');
    }

    const target: UpstreamTarget = { hostname: '127.0.0.1', port: address.port };

    return { server, target };
}

async function closeLocalServer(server: Server): Promise<void> {
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

function readHeaderValue(value: string | string[] | undefined): string {
    if (typeof value === 'string') {
        return value;
    }

    return value?.join(',') ?? '';
}

function readObservedHeaders(request: IncomingMessage): ObservedHeaders {
    return {
        host: readHeaderValue(request.headers.host),
        cookie: readHeaderValue(request.headers.cookie),
        hubSecret: readHeaderValue(request.headers['x-cloudbot-hub']),
        forwardedFor: readHeaderValue(request.headers['x-forwarded-for']),
        forwardedProto: readHeaderValue(request.headers['x-forwarded-proto']),
        incomingHubHeader: readHeaderValue(request.headers['x-browser-hub-value']),
        connection: readHeaderValue(request.headers.connection),
        removedHeader: readHeaderValue(request.headers['x-remove-me']),
    };
}

describe('createFrontDoorRoutes', () => {
    let harnesses: TestHarness[] = [];
    let localServers: Server[] = [];

    beforeEach(() => {
        harnesses = [];
        localServers = [];
    });

    afterEach(async () => {
        harnesses.forEach(closeHarness);
        await Promise.all(localServers.map(closeLocalServer));
    });

    it('routes the apex name form and hides unknown and inactive people with the same page', async () => {
        const harness = await createHarness({ domain: 'localhost', secure: false });

        harnesses.push(harness);
        const apex = await harness.app.request('http://localhost:3200/');
        const redirect = await harness.app.request('http://localhost:3200/__hub/redirect?name=maria');
        const missing = await harness.app.request('http://nobody.localhost:3200/');

        harness.people.update(PERSON_NAME, { state: 'inactive' });
        const inactiveResponse = await harness.app.request('http://maria.localhost:3200/');

        expect(apex.status)
            .toBe(200);
        expect(apex.headers.get('content-security-policy'))
            .toContain('default-src \'none\'');
        expect(redirect.headers.get('location'))
            .toBe('http://maria.localhost:3200/');
        expect(missing.status)
            .toBe(404);
        expect(await missing.text())
            .toBe(await inactiveResponse.text());
    });

    it('accepts a capitalized name on the apex form and shows a wrong name on the same page', async () => {
        const harness = await createHarness({ domain: 'localhost', secure: false });

        harnesses.push(harness);
        const capitalized = await harness.app.request('http://localhost:3200/__hub/redirect?name=%20Maria%20');
        const wrong = await harness.app.request('http://localhost:3200/__hub/redirect?name=Nobody');
        const wrongText = await wrong.text();

        expect(capitalized.headers.get('location'))
            .toBe('http://maria.localhost:3200/');
        expect(wrong.status)
            .toBe(404);
        expect(wrongText)
            .toContain('We could not find that name.');
        expect(wrongText)
            .toContain('value="Nobody"');
        expect(wrongText)
            .toContain('<form');
    });

    it('signs a person in with a secure host-only cookie and the after-login path', async () => {
        const harness = await createHarness({ afterLogin: () => '/offer' });

        harnesses.push(harness);
        const response = await login(harness.app);
        const setCookie = response.headers.get('set-cookie') ?? '';

        expect(response.status)
            .toBe(303);
        expect(response.headers.get('location'))
            .toBe('/offer');
        expect(setCookie)
            .toContain('HttpOnly');
        expect(setCookie)
            .toContain('SameSite=Strict');
        expect(setCookie)
            .toContain('Secure');
        expect(setCookie)
            .toContain('Path=/');
        expect(setCookie)
            .not.toContain('Domain=');
        expect(setCookie)
            .toContain('Max-Age=2592000');
    });

    it('omits the Secure cookie flag on localhost', async () => {
        const harness = await createHarness({ domain: 'localhost', secure: false });

        harnesses.push(harness);
        const body = new URLSearchParams({ password: INITIAL_PASSWORD });
        const response = await harness.app.request('http://maria.localhost:3200/__hub/login', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'http://maria.localhost:3200' },
            body,
        });
        const cookie = response.headers.get('set-cookie') ?? '';

        expect(response.status)
            .toBe(303);
        expect(cookie)
            .not.toContain('Secure');
    });

    it('uses the same failure message for wrong passwords and locked attempts', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const firstFailure = await login(harness.app, 'wrong password');
        const firstText = await firstFailure.text();

        expect(firstFailure.status)
            .toBe(401);
        expect(firstText)
            .toContain('Sign-in failed. Check your password and try again.');

        const additionalFailures = Array.from({ length: 4 }, () => login(harness.app, 'wrong password'));

        await Promise.all(additionalFailures);
        const lockedAttempt = await login(harness.app, INITIAL_PASSWORD);
        const lockedText = await lockedAttempt.text();

        expect(lockedAttempt.status)
            .toBe(401);
        expect(lockedText)
            .toContain('Sign-in failed. Check your password and try again.');
        expect(lockedText)
            .toBe(firstText);

        const maria = harness.people.find(PERSON_NAME);

        if (maria === undefined) {
            throw new Error('The test person was not created.');
        }

        const joao: PersonRecord = { ...maria, name: 'joao' };

        harness.people.add(joao);
        const addressLockedAttempt = await login(harness.app, INITIAL_PASSWORD, 'joao');

        expect(addressLockedAttempt.status)
            .toBe(401);

        harness.advance(15 * 60 * 1000);
        const afterLockout = await login(harness.app);

        expect(afterLockout.status)
            .toBe(303);
    });

    it('refuses cross-site POST requests before processing a password', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const body = new URLSearchParams({ password: INITIAL_PASSWORD });
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://attacker.example' },
            body,
        });

        expect(response.status)
            .toBe(403);
        expect(response.headers.get('set-cookie'))
            .toBeNull();
    });

    it('accepts a form post with Origin null when the browser says it is same-origin', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const body = new URLSearchParams({ password: INITIAL_PASSWORD });
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'null', 'sec-fetch-site': 'same-origin' },
            body,
        });

        expect(response.status)
            .toBe(303);
    });

    it('refuses a form post with Origin null that is not marked same-origin', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const body = new URLSearchParams({ password: INITIAL_PASSWORD });
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'null' },
            body,
        });

        expect(response.status)
            .toBe(403);
    });
    it('ends the session on logout', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const cookie = cookieFrom(loginResponse);
        const token = SESSION_TOKEN_PATTERN.exec(cookie)?.[1] ?? '';
        const sessions = new SqliteLoginSessions(harness.database);
        const logoutResponse = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/logout`, {
            method: 'POST',
            headers: { cookie, origin: `https://${PERSON_NAME}.example.test` },
        });

        expect(logoutResponse.headers.get('location'))
            .toBe('/__hub/login');
        expect(sessions.find(token, harness.now()))
            .toBeUndefined();
        expect(logoutResponse.headers.get('set-cookie'))
            .toContain('Max-Age=0');
    });

    it('requires a forced password change and keeps only the current session afterward', async () => {
        const harness = await createHarness({}, true);

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const currentCookie = cookieFrom(loginResponse);
        const secondSession = new SqliteLoginSessions(harness.database)
            .create(PERSON_NAME, harness.now());
        const forcedPage = await harness.app.request(`https://${PERSON_NAME}.example.test/`, { headers: { cookie: currentCookie } });
        const shortPassword = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/password`, {
            method: 'POST',
            headers: { 'cookie': currentCookie, 'origin': `https://${PERSON_NAME}.example.test`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'short', confirmation: 'short' }),
        });
        const passwordResponse = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/password`, {
            method: 'POST',
            headers: { 'cookie': currentCookie, 'origin': `https://${PERSON_NAME}.example.test`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password: 'new password value', confirmation: 'new password value' }),
        });
        const sessions = new SqliteLoginSessions(harness.database);
        const tokenMatch = SESSION_TOKEN_PATTERN.exec(loginResponse.headers.get('set-cookie') ?? '');
        const currentToken = tokenMatch?.[1] ?? '';

        expect(loginResponse.headers.get('location'))
            .toBe('/__hub/password');
        expect(forcedPage.headers.get('location'))
            .toBe('/__hub/password');
        expect(shortPassword.status)
            .toBe(401);
        expect(passwordResponse.headers.get('location'))
            .toBe('/');
        expect(harness.people.find(PERSON_NAME)?.mustChangePassword)
            .toBe(false);
        expect(sessions.find(currentToken, harness.now()))
            .toBe(PERSON_NAME);
        expect(sessions.find(secondSession, harness.now()))
            .toBeUndefined();
    });

    it('lets a signed in person change the password with the current one and ends the other sessions', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const cookie = cookieFrom(loginResponse);
        const otherSession = new SqliteLoginSessions(harness.database)
            .create(PERSON_NAME, harness.now());
        const sendChange = (current: string, password: string): Promise<Response> => Promise.resolve(harness.app.request(`https://${PERSON_NAME}.example.test/__hub/password`, {
            method: 'POST',
            headers: { 'cookie': cookie, 'origin': `https://${PERSON_NAME}.example.test`, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ current, password, confirmation: password }),
        }));
        const page = await harness.app.request(`https://${PERSON_NAME}.example.test/__hub/password`, { headers: { cookie } });
        const wrong = await sendChange('not the password', 'new password value');
        const changed = await sendChange(INITIAL_PASSWORD, 'new password value');
        const sessions = new SqliteLoginSessions(harness.database);

        expect(await page.text())
            .toContain('Current password');
        expect(wrong.status)
            .toBe(401);
        expect(await wrong.text())
            .toContain('The current password is wrong.');
        expect(changed.headers.get('location'))
            .toBe('/');
        expect(sessions.find(otherSession, harness.now()))
            .toBeUndefined();
        expect((await login(harness.app, 'new password value')).status)
            .toBe(303);
    });

    it('locks the password change after five wrong current passwords', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const cookie = cookieFrom(await login(harness.app));
        const sendChange = (current: string): Promise<Response> => Promise.resolve(harness.app.request(`https://${PERSON_NAME}.example.test/__hub/password`, {
            method: 'POST',
            headers: { 'cookie': cookie, 'origin': `https://${PERSON_NAME}.example.test`, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '203.0.113.9' },
            body: new URLSearchParams({ current, password: 'new password value', confirmation: 'new password value' }),
        }));

        await Promise.all([1, 2, 3, 4, 5].map(() => sendChange('wrong')));
        const locked = await sendChange(INITIAL_PASSWORD);

        expect(locked.status)
            .toBe(401);
        expect(await locked.text())
            .toContain('Too many wrong tries.');
    });

    it('starts a stopped instance in the background and shows the busy page after a budget refusal', async () => {
        const harness = await createHarness();

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const cookie = cookieFrom(loginResponse);

        harness.instances.setStatus(PERSON_NAME, 'stopped');
        harness.instances.startResult = 'busy';
        const loading = await harness.app.request(`https://${PERSON_NAME}.example.test/`, { headers: { cookie } });

        await Promise.resolve();
        await Promise.resolve();
        const busy = await harness.app.request(`https://${PERSON_NAME}.example.test/`, { headers: { cookie } });

        expect(loading.status)
            .toBe(200);
        expect(await loading.text())
            .toContain('This takes about a minute.');
        expect(busy.status)
            .toBe(200);
        expect(await busy.text())
            .toContain('The server is busy right now');
        expect(harness.instances.startCalls)
            .toEqual([PERSON_NAME, PERSON_NAME]);
    });

    it('strips browser trust headers and the hub cookie while adding the instance headers', async () => {
        const upstream = await startLocalServer((request, response) => {
            const observed = readObservedHeaders(request);
            const body = JSON.stringify(observed);

            response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
            response.end(body);
        });

        localServers.push(upstream.server);
        const harness = await createHarness({ upstreamFor: () => upstream.target });

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const sessionCookie = cookieFrom(loginResponse);
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test:8443/api/echo`, {
            headers: {
                'cookie': `${sessionCookie}; theme=dark`,
                'x-cloudbot-hub': 'browser-supplied-secret',
                'x-browser-hub-value': 'kept',
                'x-forwarded-for': '203.0.113.8',
                'connection': 'keep-alive, x-remove-me',
                'x-remove-me': 'drop',
            },
        });
        const observed = await response.json() as ObservedHeaders;

        expect(response.status)
            .toBe(200);
        expect(observed.host)
            .toBe(`${PERSON_NAME}.example.test:8443`);
        expect(observed.cookie)
            .toBe('theme=dark');
        expect(observed.hubSecret)
            .toBe(PERSON_SECRET);
        expect(observed.incomingHubHeader)
            .toBe('kept');
        expect(observed.forwardedFor)
            .toBe('203.0.113.8');
        expect(observed.forwardedProto)
            .toBe('https');
        expect(observed.removedHeader)
            .toBe('');
        expect(harness.activity.touches)
            .toEqual([PERSON_NAME]);
    });

    it('streams server events and tracks the long-lived response', async () => {
        let releaseStream: (() => void) | undefined;
        const streamReady = new Promise<void>((resolve) => {
            releaseStream = resolve;
        });
        const upstream = await startLocalServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write('data: first\n\n');
            void streamReady.then(() => {
                response.end('data: second\n\n');
            });
        });

        localServers.push(upstream.server);
        const harness = await createHarness({ upstreamFor: () => upstream.target });

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const cookie = cookieFrom(loginResponse);
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test/events`, { headers: { cookie } });
        const reader = response.body?.getReader();

        if (reader === undefined) {
            throw new Error('The event stream has no body.');
        }

        const firstChunk = await reader.read();
        const firstChunkBytes = firstChunk.value as Uint8Array | undefined;
        const textDecoder = new TextDecoder();
        const firstText = firstChunkBytes === undefined ? '' : textDecoder.decode(firstChunkBytes);

        expect(response.headers.get('content-type'))
            .toBe('text/event-stream');
        expect(firstText)
            .toContain('data: first');
        expect(harness.activity.openedConnections)
            .toEqual([PERSON_NAME]);
        expect(harness.activity.closedConnections)
            .toEqual([]);

        if (releaseStream === undefined) {
            throw new Error('The SSE test did not receive its release function.');
        }

        releaseStream();
        const secondChunk = await reader.read();
        const secondChunkBytes = secondChunk.value as Uint8Array | undefined;
        const secondText = secondChunkBytes === undefined ? '' : textDecoder.decode(secondChunkBytes);
        const finished = await reader.read();

        expect(secondText)
            .toContain('data: second');
        expect(finished.done)
            .toBe(true);
        expect(harness.activity.closedConnections)
            .toEqual([PERSON_NAME]);
    });

    it('shows the loading page when an instance refuses a connection while it is starting', async () => {
        const unavailable = await startLocalServer((_request, response) => {
            response.end();
        });

        await closeLocalServer(unavailable.server);
        const harness = await createHarness({ upstreamFor: () => unavailable.target });

        harnesses.push(harness);
        const loginResponse = await login(harness.app);
        const cookie = cookieFrom(loginResponse);
        const response = await harness.app.request(`https://${PERSON_NAME}.example.test/`, { headers: { cookie } });

        expect(response.status)
            .toBe(200);
        expect(await response.text())
            .toContain('This takes about a minute.');
    });
});

export {};
