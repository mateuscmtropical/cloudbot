import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { ActivityTracker, InstanceManager, PeopleStore, PersonRecord, StartResult } from '../contract.ts';
import { hashPassword, verifyPassword } from '../passwords.ts';
import { renderApexPage, renderBusyPage, renderChangePasswordPage, renderLoadingPage, renderLoginPage, renderNotAvailablePage, renderUpstreamErrorPage } from '../pages/renderPages.ts';
import type { LoginPageExtras } from '../pages/renderPages.ts';
import type { RenderedPage } from '../pages/renderPage.ts';
import type { LoginSessions } from './LoginSessions.ts';
import { readHostRoute } from './hostRouting.ts';
import { HUB_SESSION_COOKIE } from './sessionCookie.ts';

interface UpstreamTarget {
    hostname: string;
    port: number;
}

interface FrontDoorRoutesOptions {
    people: PeopleStore;
    instances: InstanceManager;
    sessions: LoginSessions;
    domain: string;
    secure: boolean;
    activity: ActivityTracker;
    afterLogin?: (name: string) => string | undefined;
    loginExtras?: LoginPageExtras;
    now?: () => number;
    upstreamFor?: (name: string) => UpstreamTarget;
}

interface FailureState {
    failures: number;
    lockedUntil: number;
}

interface HubStatusResponse {
    status: 'running' | 'starting' | 'busy' | 'stopped' | 'missing';
}

interface SessionState {
    token: string;
    name: string;
}

interface ParsedFormFields {
    [fieldName: string]: unknown;
}

interface SessionCookieOptions {
    httpOnly: true;
    secure: boolean;
    sameSite: 'Strict';
    path: '/';
    maxAge: number;
}

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const UPSTREAM_PORT = 3000;
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const LOGIN_FAILURE_MESSAGE = 'Sign-in failed. Check your password and try again.';
const UNKNOWN_CLIENT_ADDRESS = 'unknown';

function readRequestHost(context: Context): string | undefined {
    const hostHeader = context.req.header('host');

    if (hostHeader !== undefined) {
        return hostHeader;
    }

    try {
        const requestUrl = new URL(context.req.url);

        return requestUrl.host;
    } catch {
        return undefined;
    }
}

function nowFor(options: FrontDoorRoutesOptions): number {
    return options.now?.() ?? Date.now();
}

function readClientAddress(context: Context): string {
    const forwardedFor = context.req.header('x-forwarded-for');
    const firstForwardedAddress = forwardedFor?.split(',')[0]?.trim();

    if (firstForwardedAddress !== undefined && firstForwardedAddress !== '') {
        return firstForwardedAddress;
    }

    const realIp = context.req.header('x-real-ip')
        ?.trim();

    if (realIp !== undefined && realIp !== '') {
        return realIp;
    }

    try {
        const connectionInfo = getConnInfo(context);
        const remoteAddress = connectionInfo.remote.address;

        return remoteAddress ?? UNKNOWN_CLIENT_ADDRESS;
    } catch {
        return UNKNOWN_CLIENT_ADDRESS;
    }
}

function requestHasSameOrigin(context: Context, secure: boolean): boolean {
    const fetchSite = context.req.header('sec-fetch-site');
    const origin = context.req.header('origin');

    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
        return false;
    }

    if (origin === undefined) {
        return fetchSite === 'same-origin';
    }

    const host = readRequestHost(context);

    if (host === undefined) {
        return false;
    }

    try {
        const originUrl = new URL(origin);
        const expectedOrigin = `${secure ? 'https' : 'http'}://${host.toLowerCase()}`;

        return originUrl.origin === expectedOrigin;
    } catch {
        return false;
    }
}

function makeAttemptKeys(name: string, clientAddress: string): string[] {
    return [`person:${name}`, `address:${clientAddress}`];
}

function isLocked(keys: string[], failures: Map<string, FailureState>, now: number): boolean {
    return keys.some((key) => {
        const state = failures.get(key);

        return state !== undefined && state.lockedUntil > now;
    });
}

function recordFailure(keys: string[], failures: Map<string, FailureState>, now: number): void {
    keys.forEach((key) => {
        const current = failures.get(key);
        const currentFailures = current !== undefined && current.lockedUntil > 0 && current.lockedUntil <= now ? 0 : current?.failures ?? 0;
        const failureCount = currentFailures + 1;
        const lockedUntil = failureCount >= FAILURE_LIMIT ? now + LOCKOUT_MS : 0;

        failures.set(key, { failures: failureCount, lockedUntil });
    });
}

function clearFailures(keys: string[], failures: Map<string, FailureState>): void {
    keys.forEach((key) => {
        failures.delete(key);
    });
}

function renderResponse(context: Context, page: RenderedPage, status: 200 | 401 | 404 | 502 = 200): Response {
    context.header('Content-Security-Policy', page.csp);
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Cache-Control', 'no-store');

    return context.html(page.html, status);
}

function unavailable(context: Context): Response {
    const page = renderNotAvailablePage();

    return renderResponse(context, page, 404);
}

function readSession(context: Context, options: FrontDoorRoutesOptions): SessionState | undefined {
    const token = getCookie(context, HUB_SESSION_COOKIE);

    if (token === undefined || token === '') {
        return undefined;
    }

    const currentTime = nowFor(options);
    const name = options.sessions.find(token, currentTime);

    return name === undefined ? undefined : { token, name };
}

function sessionCookieOptions(options: FrontDoorRoutesOptions): SessionCookieOptions {
    return { httpOnly: true, secure: options.secure, sameSite: 'Strict', path: '/', maxAge: SESSION_MAX_AGE_SECONDS };
}

function readFormField(form: ParsedFormFields, key: string): string {
    const value = form[key];

    return typeof value === 'string' ? value : '';
}

function readAfterLoginPath(name: string, options: FrontDoorRoutesOptions): string {
    const path = options.afterLogin?.(name);

    return path !== undefined && path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

function redirectForLocalHost(name: string, hostHeader: string, domain: string, secure: boolean): string {
    const hostUrl = new URL(`http://${hostHeader}`);
    const localPort = domain.toLowerCase() === 'localhost' && hostUrl.port !== '' ? `:${hostUrl.port}` : '';
    const scheme = secure ? 'https' : 'http';

    return `${scheme}://${name}.${domain}${localPort}/`;
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

function readConnectionTokens(headers: Headers): Set<string> {
    const connection = headers.get('connection') ?? '';
    const tokens = connection.split(',')
        .map(token => token.trim()
            .toLowerCase())
        .filter(token => token !== '');

    return new Set(tokens);
}

function buildProxyHeaders(context: Context, person: PersonRecord, options: FrontDoorRoutesOptions): OutgoingHttpHeaders {
    const incomingHeaders = context.req.raw.headers;
    const connectionTokens = readConnectionTokens(incomingHeaders);
    const forwardedHeaders: OutgoingHttpHeaders = {};

    incomingHeaders.forEach((value, name) => {
        if (!HOP_BY_HOP_HEADERS.has(name) && !connectionTokens.has(name) && name !== HUB_TRUST_HEADER && name !== 'cookie') {
            forwardedHeaders[name] = value;
        }
    });

    const cookieHeader = removeSessionCookie(incomingHeaders.get('cookie') ?? undefined);

    if (cookieHeader !== undefined) {
        forwardedHeaders.cookie = cookieHeader;
    }

    forwardedHeaders.host = readRequestHost(context) ?? '';
    forwardedHeaders[HUB_TRUST_HEADER] = person.instanceSecret;
    forwardedHeaders['x-forwarded-for'] = context.req.header('x-forwarded-for') ?? readClientAddress(context);
    forwardedHeaders['x-forwarded-proto'] = options.secure ? 'https' : 'http';

    return forwardedHeaders;
}

function headerTokens(headers: IncomingHttpHeaders): Set<string> {
    const rawConnection = headers.connection ?? '';
    const connection = Array.isArray(rawConnection) ? rawConnection.join(',') : rawConnection;
    const tokens = connection.split(',')
        .map(token => token.trim()
            .toLowerCase())
        .filter(token => token !== '');

    return new Set(tokens);
}

function makeResponseHeaders(headers: IncomingHttpHeaders): Headers {
    const responseHeaders = new Headers();
    const connectionTokens = headerTokens(headers);

    Object.entries(headers)
        .forEach(([name, value]) => {
            if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || connectionTokens.has(name) || name === HUB_TRUST_HEADER) {
                return;
            }

            if (Array.isArray(value)) {
                value.forEach((entry) => {
                    responseHeaders.append(name, entry);
                });

                return;
            }

            responseHeaders.set(name, value);
        });

    return responseHeaders;
}

function selectUpstream(name: string, options: FrontDoorRoutesOptions): UpstreamTarget {
    const target = options.upstreamFor?.(name);

    return target ?? { hostname: `cloudbot-i-${name}`, port: UPSTREAM_PORT };
}

function proxyRequest(context: Context, person: PersonRecord, options: FrontDoorRoutesOptions): Promise<Response> {
    return new Promise((resolve, reject) => {
        const requestUrl = new URL(context.req.url);
        const upstream = selectUpstream(person.name, options);
        const requestOptions = {
            hostname: upstream.hostname,
            port: upstream.port,
            path: `${requestUrl.pathname}${requestUrl.search}`,
            method: context.req.method,
            headers: buildProxyHeaders(context, person, options),
        };
        const outgoingRequest = httpRequest(requestOptions, (incomingResponse) => {
            const responseHeaders = makeResponseHeaders(incomingResponse.headers);
            const contentType = incomingResponse.headers['content-type'] as string | string[] | undefined;
            const responseType = typeof contentType === 'string' ? contentType : contentType?.[0];
            const isEventStream = responseType?.toLowerCase()
                .startsWith('text/event-stream') ?? false;
            const responseStatus = incomingResponse.statusCode ?? 502;

            if (isEventStream) {
                let isClosed = false;
                const markClosed = (): void => {
                    if (!isClosed) {
                        isClosed = true;
                        options.activity.closed(person.name);
                    }
                };

                options.activity.opened(person.name);
                incomingResponse.once('end', markClosed);
                incomingResponse.once('close', markClosed);
            }

            const responseBody = context.req.method === 'HEAD' || responseStatus === 204 || responseStatus === 304
                ? null
                : Readable.toWeb(incomingResponse) as ReadableStream<Uint8Array>;
            const responseStatusText = incomingResponse.statusMessage;
            const response = new Response(responseBody, {
                status: responseStatus,
                ...(responseStatusText === undefined ? {} : { statusText: responseStatusText }),
                headers: responseHeaders,
            });

            resolve(response);
        });

        outgoingRequest.once('error', reject);

        const requestBody = context.req.raw.body;

        if (requestBody === null) {
            outgoingRequest.end();
        } else {
            const bodyStream = Readable.fromWeb(requestBody);

            bodyStream.once('error', (error: Error) => {
                outgoingRequest.destroy(error);
            });
            bodyStream.pipe(outgoingRequest);
        }

        context.req.raw.signal.addEventListener('abort', () => {
            outgoingRequest.destroy();
        }, { once: true });
    });
}

function beginStart(name: string, options: FrontDoorRoutesOptions, pendingStarts: Map<string, Promise<void>>, busyPeople: Set<string>): void {
    if (pendingStarts.has(name)) {
        return;
    }

    const startResult = Promise.resolve()
        .then(() => options.instances.start(name));
    const trackedStart = startResult.then((result: StartResult) => {
        if (result === 'busy') {
            busyPeople.add(name);

            return;
        }

        busyPeople.delete(name);
    }, () => {
        busyPeople.delete(name);
    });

    pendingStarts.set(name, trackedStart);
    const finishedStart = trackedStart.finally(() => {
        pendingStarts.delete(name);
    });

    void finishedStart.catch(() => undefined);
}

function createFrontDoorRoutes(options: FrontDoorRoutesOptions): Hono {
    const app = new Hono();
    const failures = new Map<string, FailureState>();
    const pendingStarts = new Map<string, Promise<void>>();
    const busyPeople = new Set<string>();

    app.all('*', async (context, next) => {
        if (context.req.path === '/internal' || context.req.path.startsWith('/internal/')) {
            await next();

            return;
        }

        if (context.req.method === 'POST' && !requestHasSameOrigin(context, options.secure)) {
            return context.text('This request did not come from this page.', 403);
        }

        const hostHeader = readRequestHost(context);
        const hostRoute = readHostRoute(hostHeader, options.domain);

        if (hostRoute === undefined) {
            return unavailable(context);
        }

        if (hostRoute.isApex) {
            if (context.req.method === 'GET' && context.req.path === '/') {
                const apexPage = renderApexPage();

                return renderResponse(context, apexPage);
            }

            if (context.req.method === 'GET' && context.req.path === '/__hub/redirect') {
                const name = context.req.query('name') ?? '';

                if (checkPersonName(name) !== undefined || hostHeader === undefined) {
                    return unavailable(context);
                }

                const location = redirectForLocalHost(name, hostHeader, options.domain, options.secure);

                return context.redirect(location, 303);
            }

            return unavailable(context);
        }

        const name = hostRoute.name;

        if (name === undefined) {
            return unavailable(context);
        }

        const person = options.people.find(name);

        if (person === undefined || person.state !== 'active') {
            return unavailable(context);
        }

        if (context.req.path === '/__hub/login' && context.req.method === 'GET') {
            const currentSession = readSession(context, options);

            if (currentSession?.name === name) {
                const redirectPath = person.mustChangePassword ? '/__hub/password' : '/';

                return context.redirect(redirectPath, 303);
            }

            const loginPage = renderLoginPage({ name, extras: options.loginExtras });

            return renderResponse(context, loginPage);
        }

        if (context.req.path === '/__hub/login' && context.req.method === 'POST') {
            const clientAddress = readClientAddress(context);
            const attemptKeys = makeAttemptKeys(name, clientAddress);
            const currentTime = nowFor(options);
            const isAttemptLocked = isLocked(attemptKeys, failures, currentTime);

            if (isAttemptLocked) {
                const lockedLoginPage = renderLoginPage({ name, error: LOGIN_FAILURE_MESSAGE, extras: options.loginExtras });

                return renderResponse(context, lockedLoginPage, 401);
            }

            const form = await context.req.parseBody()
                .catch((): ParsedFormFields => ({}));
            const password = readFormField(form, 'password');
            const passwordMatches = await verifyPassword(password, person.passwordHash)
                .catch(() => false);

            if (!passwordMatches) {
                recordFailure(attemptKeys, failures, currentTime);
                const rejectedLoginPage = renderLoginPage({ name, error: LOGIN_FAILURE_MESSAGE, extras: options.loginExtras });

                return renderResponse(context, rejectedLoginPage, 401);
            }

            clearFailures(attemptKeys, failures);
            const token = options.sessions.create(name, currentTime);
            const cookieOptions = sessionCookieOptions(options);

            setCookie(context, HUB_SESSION_COOKIE, token, cookieOptions);
            options.people.update(name, { lastSeenAt: currentTime });
            const redirectPath = person.mustChangePassword ? '/__hub/password' : readAfterLoginPath(name, options);

            return context.redirect(redirectPath, 303);
        }

        const session = readSession(context, options);

        if (session === undefined || session.name !== name) {
            const loginPage = renderLoginPage({ name, extras: options.loginExtras });

            return renderResponse(context, loginPage);
        }

        if (person.mustChangePassword) {
            if (context.req.path === '/__hub/password' && context.req.method === 'GET') {
                const changePage = renderChangePasswordPage();

                return renderResponse(context, changePage);
            }

            if (context.req.path === '/__hub/password' && context.req.method === 'POST') {
                const form = await context.req.parseBody()
                    .catch((): ParsedFormFields => ({}));
                const password = readFormField(form, 'password');
                const confirmation = readFormField(form, 'confirmation');

                if (password.length < 10 || password !== confirmation) {
                    const error = password.length < 10 ? 'Use at least 10 characters.' : 'The passwords do not match.';
                    const changePage = renderChangePasswordPage({ error });

                    return renderResponse(context, changePage, 401);
                }

                const passwordHash = await hashPassword(password);

                options.people.update(name, { passwordHash, mustChangePassword: false, lastSeenAt: nowFor(options) });
                options.sessions.deleteOtherSessions(name, session.token);

                return context.redirect('/', 303);
            }

            return context.redirect('/__hub/password', 303);
        }

        if (context.req.path === '/__hub/logout' && context.req.method === 'POST') {
            options.sessions.delete(session.token);
            setCookie(context, HUB_SESSION_COOKIE, '', { ...sessionCookieOptions(options), maxAge: 0 });

            return context.redirect('/__hub/login', 303);
        }

        if (context.req.path === '/__hub/login' || context.req.path === '/__hub/password') {
            return context.redirect('/', 303);
        }

        if (context.req.path === '/__hub/status' && context.req.method === 'GET') {
            const instanceStatus = await options.instances.status(name)
                .catch(() => undefined);

            if (instanceStatus === undefined) {
                const error: HubStatusResponse = { status: 'stopped' };

                return context.json(error, 502);
            }

            const status: HubStatusResponse = busyPeople.has(name) ? { status: 'busy' } : { status: instanceStatus };

            return context.json(status);
        }

        const instanceStatus = await options.instances.status(name)
            .catch(() => undefined);

        if (instanceStatus === undefined) {
            const errorPage = renderUpstreamErrorPage();

            return renderResponse(context, errorPage, 502);
        }

        if (instanceStatus !== 'running') {
            beginStart(name, options, pendingStarts, busyPeople);
            const startupPage = busyPeople.has(name) ? renderBusyPage() : renderLoadingPage();

            return renderResponse(context, startupPage);
        }

        busyPeople.delete(name);
        options.activity.touch(name);
        options.people.update(name, { lastSeenAt: nowFor(options) });
        const proxiedResponse = await proxyRequest(context, person, options)
            .catch(() => undefined);

        if (proxiedResponse === undefined) {
            const errorPage = renderUpstreamErrorPage();

            return renderResponse(context, errorPage, 502);
        }

        return proxiedResponse;
    });

    return app;
}

export { createFrontDoorRoutes, requestHasSameOrigin };
export type { FrontDoorRoutesOptions, UpstreamTarget };
