import { request as httpRequest } from 'node:http';
import type { BlockList } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { Hono } from 'hono';

import { HUB_TRUST_HEADER } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { ActivityTracker, InstanceManager, PeopleStore, PersonRecord, StartResult } from '../contract.ts';
import { hashPassword, verifyPassword } from '../passwords.ts';
import { renderApexPage, renderBusyPage, renderChangePasswordPage, renderLoadingPage, renderLoginPage, renderSetupPage, renderUpstreamErrorPage } from '../pages/renderPages.ts';
import type { LoginPageExtras } from '../pages/renderPages.ts';
import type { LoginSessions } from './LoginSessions.ts';
import { readHostRoute } from './hostRouting.ts';
import { clearHubSessionCookie, isClientAddressAllowed, readClientAddress, readHubSession, readRequestHost, renderResponse, renderUnavailable, requestHasSameOrigin, SIGN_IN_DENIED_MESSAGE, startHubSession } from './routeHelpers.ts';
import { HUB_SESSION_COOKIE } from './sessionCookie.ts';

interface UpstreamTarget {
    hostname: string;
    port: number;
}

interface OwnerSetupOptions {
    ownerName: string;
    createOwner: (passwordHash: string) => Promise<void>;
}

interface OwnerSetupState {
    isClaiming: boolean;
}

interface OwnerSetupRoute {
    isApex: boolean;
    name: string | undefined;
}

interface FrontDoorRoutesOptions {
    people: PeopleStore;
    instances: InstanceManager;
    sessions: LoginSessions;
    domain: string;
    secure: boolean;
    activity: ActivityTracker;
    afterLogin?: (name: string, context: Context) => string | undefined;
    loginExtras?: LoginPageExtras;
    loginAllowedIps?: BlockList;
    ownerSetup?: OwnerSetupOptions;
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

interface ParsedFormFields {
    [fieldName: string]: unknown;
}

interface SignInDeniedResponse {
    error: string;
}

const FAILURE_LIMIT = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const UPSTREAM_PORT = 3000;
const UPSTREAM_CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const LOGIN_FAILURE_MESSAGE = 'Sign-in failed. Check your password and try again.';
const TOO_MANY_TRIES_MESSAGE = 'Too many wrong tries. Try again in a few minutes.';

function nowFor(options: FrontDoorRoutesOptions): number {
    return options.now?.() ?? Date.now();
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

function readFormField(form: ParsedFormFields, key: string): string {
    const value = form[key];

    return typeof value === 'string' ? value : '';
}

function readAfterLoginPath(name: string, options: FrontDoorRoutesOptions, context: Context): string {
    const path = options.afterLogin?.(name, context);

    return path !== undefined && path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

// The pattern of every person's address, for the form-action of the name form.
function personOriginPattern(hostHeader: string, domain: string, secure: boolean): string {
    const hostUrl = new URL(`http://${hostHeader}`);
    const localPort = domain.toLowerCase() === 'localhost' && hostUrl.port !== '' ? `:${hostUrl.port}` : '';
    const scheme = secure ? 'https' : 'http';

    return `${scheme}://*.${domain}${localPort}`;
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

function isUpstreamConnectionFailure(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }

    const code = error.code;

    return typeof code === 'string' && UPSTREAM_CONNECT_FAILURE_CODES.has(code);
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

async function handleOwnerSetup(context: Context, options: FrontDoorRoutesOptions, setup: OwnerSetupOptions, state: OwnerSetupState, route: OwnerSetupRoute): Promise<Response> {
    const hostHeader = readRequestHost(context);

    if (route.isApex) {
        if (hostHeader === undefined || context.req.method !== 'GET' || context.req.path !== '/') {
            return renderUnavailable(context);
        }

        const location = redirectForLocalHost(setup.ownerName, hostHeader, options.domain, options.secure);

        return context.redirect(location, 303);
    }

    if (route.name !== setup.ownerName) {
        return renderUnavailable(context);
    }

    if (context.req.method === 'POST' && context.req.path === '/__hub/setup') {
        const form = await context.req.parseBody()
            .catch((): ParsedFormFields => ({}));
        const password = readFormField(form, 'password');
        const confirmation = readFormField(form, 'confirmation');

        if (password.length < 10 || password !== confirmation) {
            const error = password.length < 10 ? 'Use at least 10 characters.' : 'The passwords do not match.';
            const invalidPage = renderSetupPage({ ownerName: setup.ownerName, error });

            return renderResponse(context, invalidPage, 401);
        }

        if (state.isClaiming) {
            return renderUnavailable(context);
        }

        state.isClaiming = true;
        const passwordHash = await hashPassword(password);
        const isCreated = await setup.createOwner(passwordHash)
            .then(() => true, () => false);

        state.isClaiming = false;

        if (!isCreated) {
            const failedPage = renderSetupPage({ ownerName: setup.ownerName, error: 'Could not set up CloudBot. Try again.' });

            return renderResponse(context, failedPage, 500);
        }

        const setupTime = nowFor(options);

        startHubSession(context, options.sessions, setup.ownerName, options.secure, setupTime);

        return context.redirect('/', 303);
    }

    if (context.req.method !== 'GET') {
        return renderUnavailable(context);
    }

    const setupPage = renderSetupPage({ ownerName: setup.ownerName });

    return renderResponse(context, setupPage);
}

function createFrontDoorRoutes(options: FrontDoorRoutesOptions): Hono {
    const app = new Hono();
    const loginAllowedIps = options.loginAllowedIps;
    const failures = new Map<string, FailureState>();
    const pendingStarts = new Map<string, Promise<void>>();
    const busyPeople = new Set<string>();
    const setupState: OwnerSetupState = { isClaiming: false };

    app.all('*', async (context, next) => {
        if (context.req.path === '/internal' || context.req.path.startsWith('/internal/')) {
            await next();

            return;
        }

        const isPasswordLogin = context.req.path === '/__hub/login'
            && (context.req.method === 'GET' || context.req.method === 'POST');
        const isPasswordChange = (context.req.path === '/__hub/password' || context.req.path === '/__hub/setup') && context.req.method === 'POST';

        if (loginAllowedIps !== undefined && (isPasswordLogin || isPasswordChange)) {
            const clientAddress = readClientAddress(context);
            const isAddressAllowed = isClientAddressAllowed(clientAddress, loginAllowedIps);

            if (!isAddressAllowed) {
                const error: SignInDeniedResponse = { error: SIGN_IN_DENIED_MESSAGE };

                return context.json(error, 403);
            }
        }

        if (context.req.method === 'POST' && !requestHasSameOrigin(context, options.secure)) {
            return context.text('This request did not come from this page.', 403);
        }

        const hostHeader = readRequestHost(context);
        const hostRoute = readHostRoute(hostHeader, options.domain);

        if (hostRoute === undefined) {
            return renderUnavailable(context);
        }

        const hasOwner = options.people.list()
            .some(person => person.role === 'owner');

        if (options.ownerSetup !== undefined && !hasOwner) {
            const setupRoute: OwnerSetupRoute = { isApex: hostRoute.isApex, name: hostRoute.name };

            return handleOwnerSetup(context, options, options.ownerSetup, setupState, setupRoute);
        }

        if (hostRoute.isApex) {
            if (context.req.method === 'GET' && context.req.path === '/') {
                const apexPage = renderApexPage(hostHeader === undefined ? {} : { formActionOrigin: personOriginPattern(hostHeader, options.domain, options.secure) });

                return renderResponse(context, apexPage);
            }

            if (context.req.method === 'GET' && context.req.path === '/__hub/redirect') {
                const typedName = context.req.query('name') ?? '';
                // Names are lowercase, and a phone keyboard or a habit may capitalize or add a space.
                const name = typedName.trim()
                    .toLowerCase();
                const typedPerson = checkPersonName(name) === undefined ? options.people.find(name) : undefined;

                if (typedPerson === undefined || typedPerson.state !== 'active' || hostHeader === undefined) {
                    const retryOrigin = hostHeader === undefined ? undefined : personOriginPattern(hostHeader, options.domain, options.secure);
                    const retryPage = renderApexPage({ name: typedName, error: 'We could not find that name. Check it and try again.', formActionOrigin: retryOrigin });

                    return renderResponse(context, retryPage, 404);
                }

                const location = redirectForLocalHost(name, hostHeader, options.domain, options.secure);

                return context.redirect(location, 303);
            }

            return renderUnavailable(context);
        }

        const name = hostRoute.name;

        if (name === undefined) {
            return renderUnavailable(context);
        }

        const person = options.people.find(name);

        if (person === undefined || person.state !== 'active') {
            return renderUnavailable(context);
        }

        if (context.req.path === '/__hub/login' && context.req.method === 'GET') {
            const currentTime = nowFor(options);
            const currentSession = readHubSession(context, options.sessions, currentTime);

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
            startHubSession(context, options.sessions, name, options.secure, currentTime);
            options.people.update(name, { lastSeenAt: currentTime });
            const redirectPath = person.mustChangePassword ? '/__hub/password' : readAfterLoginPath(name, options, context);

            return context.redirect(redirectPath, 303);
        }

        const currentTime = nowFor(options);
        const session = readHubSession(context, options.sessions, currentTime);

        if (session === undefined || session.name !== name) {
            const loginPage = renderLoginPage({ name, extras: options.loginExtras });

            return renderResponse(context, loginPage);
        }

        // A generated password must be changed first. Later the person changes it from the account menu, with the current one.
        const needsCurrent = !person.mustChangePassword;

        if (context.req.path === '/__hub/password' && context.req.method === 'GET') {
            const changePage = renderChangePasswordPage({ needsCurrent });

            return renderResponse(context, changePage);
        }

        if (context.req.path === '/__hub/password' && context.req.method === 'POST') {
            const form = await context.req.parseBody()
                .catch((): ParsedFormFields => ({}));
            const password = readFormField(form, 'password');
            const confirmation = readFormField(form, 'confirmation');

            if (needsCurrent) {
                const changeAddress = readClientAddress(context);
                const attemptKeys = makeAttemptKeys(name, changeAddress);

                if (isLocked(attemptKeys, failures, currentTime)) {
                    const lockedPage = renderChangePasswordPage({ needsCurrent, error: TOO_MANY_TRIES_MESSAGE });

                    return renderResponse(context, lockedPage, 401);
                }

                const typedCurrent = readFormField(form, 'current');
                const currentMatches = await verifyPassword(typedCurrent, person.passwordHash)
                    .catch(() => false);

                if (!currentMatches) {
                    recordFailure(attemptKeys, failures, currentTime);
                    const wrongPage = renderChangePasswordPage({ needsCurrent, error: 'The current password is wrong.' });

                    return renderResponse(context, wrongPage, 401);
                }

                clearFailures(attemptKeys, failures);
            }

            if (password.length < 10 || password !== confirmation) {
                const error = password.length < 10 ? 'Use at least 10 characters.' : 'The passwords do not match.';
                const changePage = renderChangePasswordPage({ needsCurrent, error });

                return renderResponse(context, changePage, 401);
            }

            const passwordHash = await hashPassword(password);

            options.people.update(name, { passwordHash, mustChangePassword: false, lastSeenAt: nowFor(options) });
            options.sessions.deleteOtherSessions(name, session.token);

            return context.redirect('/', 303);
        }

        if (person.mustChangePassword) {
            return context.redirect('/__hub/password', 303);
        }

        if (context.req.path === '/__hub/logout' && context.req.method === 'POST') {
            options.sessions.delete(session.token);
            clearHubSessionCookie(context, options.secure);

            return context.redirect('/__hub/login', 303);
        }

        if (context.req.path === '/__hub/login') {
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
        let proxyError: unknown;
        const proxiedResponse = await proxyRequest(context, person, options)
            .catch((error: unknown) => {
                proxyError = error;

                return undefined;
            });

        if (proxiedResponse === undefined) {
            const latestStatus = await options.instances.status(name)
                .catch(() => undefined);

            if (latestStatus !== 'running') {
                beginStart(name, options, pendingStarts, busyPeople);
            }

            if (isUpstreamConnectionFailure(proxyError) || latestStatus !== 'running') {
                const startupPage = busyPeople.has(name) ? renderBusyPage() : renderLoadingPage();

                return renderResponse(context, startupPage);
            }

            const errorPage = renderUpstreamErrorPage();

            return renderResponse(context, errorPage, 502);
        }

        return proxiedResponse;
    });

    return app;
}

export { createFrontDoorRoutes, requestHasSameOrigin };
export type { FrontDoorRoutesOptions, OwnerSetupOptions, UpstreamTarget };
