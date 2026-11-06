import { request as httpRequest } from 'node:http';
import type { BlockList } from 'node:net';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { APP_OAUTH_CALLBACK_PATH } from '../../shared/connectedApps.ts';
import { ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, HUB_TRUST_HEADER, WHATSAPP_CALLBACK_PATH } from '../../shared/hubProtocol.ts';
import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { ActivityTracker, GroupMembersStore, InstanceManager, PeopleStore, PersonRecord, StartResult } from '../contract.ts';
import { hashPassword, verifyPassword } from '../passwords.ts';
import { renderApexPage, renderBusyPage, renderChangePasswordPage, renderGroupEntryPage, renderLoadingPage, renderLoginPage, renderSetupPage, renderUpstreamErrorPage } from '../pages/renderPages.ts';
import type { LoginPageExtras } from '../pages/renderPages.ts';
import { readActingPerson } from './groupAccess.ts';
import type { ActingPerson, GroupEntryTickets } from './groupAccess.ts';
import type { LoginSessions } from './LoginSessions.ts';
import { GROUP_MEMBERS_PATH, serveGroupMembers } from './groupMembersApi.ts';
import { readHostRoute } from './hostRouting.ts';
import { clearHubSessionCookie, isClientAddressAllowed, readClientAddress, readHubSession, readRequestHost, renderResponse, renderUnavailable, requestHasSameOrigin, SIGN_IN_DENIED_MESSAGE, startHubSession } from './routeHelpers.ts';
import { removeHubSessionCookies } from './sessionCookie.ts';

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
    // Without these two a group's address is not available.
    members?: GroupMembersStore;
    entryTickets?: GroupEntryTickets;
}

// The pieces a request to a running instance needs once the session is checked.
interface InstanceServing {
    pendingStarts: Map<string, Promise<void>>;
    busyPeople: Set<string>;
}

interface AttemptKey {
    key: string;
    limit: number;
}

interface FailureState {
    failures: number;
    lockedUntil: number;
}

interface HubStatusResponse {
    status: 'running' | 'starting' | 'busy' | 'stopped' | 'missing';
}

interface InstanceStartingResponse {
    error: string;
}

interface ParsedFormFields {
    [fieldName: string]: unknown;
}

interface SignInDeniedResponse {
    error: string;
}

// One address gets few tries at one person. Many addresses together get more, so a stranger cannot lock the person out
// of the password sign-in with a handful of wrong tries.
const NAME_AND_ADDRESS_FAILURE_LIMIT = 5;
const PERSON_FAILURE_LIMIT = 50;
const LOCKOUT_MS = 15 * 60 * 1000;
const UPSTREAM_PORT = 3000;
const UPSTREAM_CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);
const HOP_BY_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const INSTANCE_STARTING_MESSAGE = 'The instance is starting.';
const LOGIN_FAILURE_MESSAGE = 'Sign-in failed. Check your password and try again.';
const TOO_MANY_TRIES_MESSAGE = 'Too many wrong tries. Try again in a few minutes.';
const MAX_FORM_BODY_BYTES = 16 * 1024;
const FORM_PATHS = ['/__hub/login', '/__hub/setup', '/__hub/password'];
const GROUP_OPEN_PATH_PATTERN = /^\/__hub\/groups\/([a-z0-9-]{2,30})\/open$/;
const GROUP_ENTER_PATH = '/__hub/enter';
// The token of createWebhookToken is base64url text. No dot, slash or percent sign fits, so no other path can pass.
const WEBHOOK_PATH_PATTERN = /^\/hooks\/[A-Za-z0-9_-]+$/;

function nowFor(options: FrontDoorRoutesOptions): number {
    return options.now?.() ?? Date.now();
}

function makeAttemptKeys(name: string, clientAddress: string): AttemptKey[] {
    return [
        { key: `person:${name}`, limit: PERSON_FAILURE_LIMIT },
        { key: `address:${name}:${clientAddress}`, limit: NAME_AND_ADDRESS_FAILURE_LIMIT },
    ];
}

function isLocked(keys: AttemptKey[], failures: Map<string, FailureState>, now: number): boolean {
    return keys.some(({ key }) => {
        const state = failures.get(key);

        return state !== undefined && state.lockedUntil > now;
    });
}

function recordFailure(keys: AttemptKey[], failures: Map<string, FailureState>, now: number): void {
    keys.forEach(({ key, limit }) => {
        const current = failures.get(key);
        const currentFailures = current !== undefined && current.lockedUntil > 0 && current.lockedUntil <= now ? 0 : current?.failures ?? 0;
        const failureCount = currentFailures + 1;
        const lockedUntil = failureCount >= limit ? now + LOCKOUT_MS : 0;

        failures.set(key, { failures: failureCount, lockedUntil });
    });
}

function clearFailures(keys: AttemptKey[], failures: Map<string, FailureState>): void {
    keys.forEach(({ key }) => {
        failures.delete(key);
    });
}

// Webhook senders and Meta are not browsers, so they have no session and no origin headers. Each route checks its own
// token or signature on the instance. The path is read the same way proxyRequest reads it.
function isPublicInstanceCall(context: Context): boolean {
    const method = context.req.method;
    const requestUrl = new URL(context.req.url);

    if (requestUrl.pathname === WHATSAPP_CALLBACK_PATH) {
        return method === 'GET' || method === 'POST';
    }

    return method === 'POST' && WEBHOOK_PATH_PATTERN.test(requestUrl.pathname);
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

function personOrigin(name: string, hostHeader: string, domain: string, secure: boolean): string {
    const hostUrl = new URL(`http://${hostHeader}`);
    const localPort = domain.toLowerCase() === 'localhost' && hostUrl.port !== '' ? `:${hostUrl.port}` : '';
    const scheme = secure ? 'https' : 'http';

    return `${scheme}://${name}.${domain}${localPort}`;
}

function redirectForLocalHost(name: string, hostHeader: string, domain: string, secure: boolean): string {
    return `${personOrigin(name, hostHeader, domain, secure)}/`;
}

// Google takes one redirect address per client, so every Google sign-in comes back to the apex. The instance made the
// state start with the person name and a dot. The browser goes on to that person's callback with the query unchanged.
// Anything else, such as an unknown name or a state without a name, gets no redirect.
function readGoogleReturnLocation(context: Context, options: FrontDoorRoutesOptions, hostHeader: string | undefined): string | undefined {
    const state = context.req.query('state') ?? '';
    const separatorIndex = state.indexOf('.');
    const name = separatorIndex < 1 ? '' : state.slice(0, separatorIndex);
    const person = checkPersonName(name) === undefined ? options.people.find(name) : undefined;

    if (person === undefined || person.state !== 'active' || hostHeader === undefined) {
        return undefined;
    }

    const origin = personOrigin(name, hostHeader, options.domain, options.secure);
    const requestAddress = new URL(context.req.url);

    return `${origin}${APP_OAUTH_CALLBACK_PATH}${requestAddress.search}`;
}

function readConnectionTokens(headers: Headers): Set<string> {
    const connection = headers.get('connection') ?? '';
    const tokens = connection.split(',')
        .map(token => token.trim()
            .toLowerCase())
        .filter(token => token !== '');

    return new Set(tokens);
}

// Only the hub says who acts, so a browser cannot claim to be someone else in a group.
const HUB_ONLY_HEADERS = new Set([HUB_TRUST_HEADER, ACTING_PERSON_HEADER, ACTING_ROLE_HEADER, 'cookie']);

function buildProxyHeaders(context: Context, person: PersonRecord, options: FrontDoorRoutesOptions, acting: ActingPerson | undefined): OutgoingHttpHeaders {
    const incomingHeaders = context.req.raw.headers;
    const connectionTokens = readConnectionTokens(incomingHeaders);
    const forwardedHeaders: OutgoingHttpHeaders = {};

    incomingHeaders.forEach((value, name) => {
        if (!HOP_BY_HOP_HEADERS.has(name) && !connectionTokens.has(name) && !HUB_ONLY_HEADERS.has(name)) {
            forwardedHeaders[name] = value;
        }
    });

    if (acting?.groupRole !== undefined) {
        forwardedHeaders[ACTING_PERSON_HEADER] = acting.name;
        forwardedHeaders[ACTING_ROLE_HEADER] = acting.groupRole;
    }

    const cookieHeader = removeHubSessionCookies(incomingHeaders.get('cookie') ?? undefined);

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

// A fetch cannot run the loading page's script to retry its request.
function renderStartupResponse(context: Context, isBusy: boolean): Response {
    if (context.req.path.startsWith('/api/')) {
        const response: InstanceStartingResponse = { error: INSTANCE_STARTING_MESSAGE };

        return context.json(response, 503);
    }

    const page = isBusy ? renderBusyPage() : renderLoadingPage();

    return renderResponse(context, page);
}

function proxyRequest(context: Context, person: PersonRecord, options: FrontDoorRoutesOptions, acting?: ActingPerson): Promise<Response> {
    return new Promise((resolve, reject) => {
        const requestUrl = new URL(context.req.url);
        const upstream = selectUpstream(person.name, options);
        const requestOptions = {
            hostname: upstream.hostname,
            port: upstream.port,
            path: `${requestUrl.pathname}${requestUrl.search}`,
            method: context.req.method,
            headers: buildProxyHeaders(context, person, options, acting),
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
    }, (error: unknown) => {
        // Without this line a failed start only shows as a page that loads without end.
        console.error(`Could not start the instance of ${name}:`, error);
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

// Status, start and proxy of an instance, for a request whose session is already checked.
async function serveInstance(context: Context, person: PersonRecord, options: FrontDoorRoutesOptions, serving: InstanceServing, acting: ActingPerson): Promise<Response> {
    const name = person.name;
    const { pendingStarts, busyPeople } = serving;

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
        const isBusy = busyPeople.has(name);

        return renderStartupResponse(context, isBusy);
    }

    busyPeople.delete(name);
    options.activity.touch(name);
    options.people.update(name, { lastSeenAt: nowFor(options) });
    let proxyError: unknown;
    const proxiedResponse = await proxyRequest(context, person, options, acting)
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
            const isBusy = busyPeople.has(name);

            return renderStartupResponse(context, isBusy);
        }

        const errorPage = renderUpstreamErrorPage();

        return renderResponse(context, errorPage, 502);
    }

    return proxiedResponse;
}

// On the person's own address, with the person's session: sends the browser to the group with a one-time ticket.
function openGroup(context: Context, options: FrontDoorRoutesOptions, personName: string, groupName: string, hostHeader: string | undefined): Response {
    const group = options.people.find(groupName);
    const isMember = options.members?.roleOf(groupName, personName) !== undefined;

    if (group === undefined || group.role !== 'group' || group.state !== 'active' || !isMember || options.entryTickets === undefined || hostHeader === undefined) {
        return renderUnavailable(context);
    }

    const now = nowFor(options);
    const token = options.entryTickets.issue(groupName, personName, now);
    const groupOrigin = personOrigin(groupName, hostHeader, options.domain, options.secure);
    const encodedToken = encodeURIComponent(token);

    return context.redirect(`${groupOrigin}${GROUP_ENTER_PATH}?token=${encodedToken}`, 303);
}

// A group's address. Nobody signs in as the group: its members come from their own address with a ticket, and each
// request reaches the instance with who acts and their role. The hub's password and passkey pages are not here.
async function serveGroup(context: Context, group: PersonRecord, options: FrontDoorRoutesOptions, serving: InstanceServing): Promise<Response> {
    const members = options.members;

    if (members === undefined) {
        return renderUnavailable(context);
    }

    if (context.req.path === GROUP_ENTER_PATH && context.req.method === 'GET') {
        const token = context.req.query('token') ?? '';
        const currentTime = nowFor(options);
        const personName = options.entryTickets?.redeem(token, group.name, currentTime);
        const enteringPerson = personName === undefined ? undefined : options.people.find(personName);
        const canEnter = enteringPerson !== undefined && enteringPerson.state === 'active' && enteringPerson.role !== 'group'
            && members.roleOf(group.name, enteringPerson.name) !== undefined;

        if (!canEnter) {
            const entryPage = renderGroupEntryPage();

            return renderResponse(context, entryPage, 401);
        }

        startHubSession(context, options.sessions, enteringPerson.name, options.secure, currentTime);

        return context.redirect('/', 303);
    }

    if (isPublicInstanceCall(context)) {
        const publicCallStatus = await options.instances.status(group.name)
            .catch(() => undefined);
        const publicCallResponse = publicCallStatus === 'running'
            ? await proxyRequest(context, group, options)
                    .catch(() => undefined)
            : undefined;
        const startingError: InstanceStartingResponse = { error: INSTANCE_STARTING_MESSAGE };

        return publicCallResponse ?? context.json(startingError, 503);
    }

    if (context.req.method === 'GET' && context.req.path === APP_OAUTH_CALLBACK_PATH) {
        const callbackStatus = await options.instances.status(group.name)
            .catch(() => undefined);
        const callbackResponse = callbackStatus === 'running'
            ? await proxyRequest(context, group, options)
                    .catch(() => undefined)
            : undefined;

        return callbackResponse ?? context.redirect('/', 303);
    }

    const currentTime = nowFor(options);
    const session = readHubSession(context, options.sessions, currentTime, options.secure);
    const sessionPerson = session === undefined ? undefined : options.people.find(session.name);
    const acting = sessionPerson?.state === 'active' ? readActingPerson(group, sessionPerson.name, members) : undefined;

    if (session === undefined || acting === undefined) {
        const entryPage = renderGroupEntryPage();

        return renderResponse(context, entryPage, 401);
    }

    if (context.req.path === '/__hub/logout' && context.req.method === 'POST') {
        options.sessions.delete(session.token);
        clearHubSessionCookie(context, options.secure);

        return context.redirect('/', 303);
    }

    // Served by the hub, which knows who acts. The group instance never decides who is in the group.
    if (context.req.path === GROUP_MEMBERS_PATH && acting.groupRole !== undefined) {
        return serveGroupMembers(context, { people: options.people, members, groupName: group.name, actingName: acting.name, actingRole: acting.groupRole });
    }

    if (context.req.path.startsWith('/__hub/') && context.req.path !== '/__hub/status') {
        return context.redirect('/', 303);
    }

    return serveInstance(context, group, options, serving, acting);
}

function createFrontDoorRoutes(options: FrontDoorRoutesOptions): Hono {
    const app = new Hono();
    const loginAllowedIps = options.loginAllowedIps;
    const failures = new Map<string, FailureState>();
    const pendingStarts = new Map<string, Promise<void>>();
    const busyPeople = new Set<string>();
    const setupState: OwnerSetupState = { isClaiming: false };
    const serving: InstanceServing = { pendingStarts, busyPeople };
    const limitFormBody = bodyLimit({
        maxSize: MAX_FORM_BODY_BYTES,
        onError: context => context.text('The request is too large.', 413),
    });

    FORM_PATHS.forEach((path) => {
        app.post(path, limitFormBody);
    });

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

        const isPublicCall = isPublicInstanceCall(context);

        if (context.req.method === 'POST' && !isPublicCall && !requestHasSameOrigin(context, options.secure)) {
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

            if (context.req.method === 'GET' && context.req.path === APP_OAUTH_CALLBACK_PATH) {
                const returnLocation = readGoogleReturnLocation(context, options, hostHeader);

                return returnLocation === undefined ? renderUnavailable(context) : context.redirect(returnLocation, 303);
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

        if (person.role === 'group') {
            return serveGroup(context, person, options, serving);
        }

        if (context.req.path === '/__hub/login' && context.req.method === 'GET') {
            const currentTime = nowFor(options);
            const currentSession = readHubSession(context, options.sessions, currentTime, options.secure);

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

        // A stranger's call does not wake an instance. One with a webhook or WhatsApp is not stopped for being idle, so this
        // only happens after a restart of the server, and the sender can try again.
        if (isPublicCall) {
            const publicCallStatus = await options.instances.status(name)
                .catch(() => undefined);
            const publicCallResponse = publicCallStatus === 'running'
                ? await proxyRequest(context, person, options)
                        .catch(() => undefined)
                : undefined;
            const startingError: InstanceStartingResponse = { error: INSTANCE_STARTING_MESSAGE };

            return publicCallResponse ?? context.json(startingError, 503);
        }

        // A connected app's sign-in page sends the owner back from another site, which may arrive without the hub cookie.
        // This one path goes to the instance without a session. The instance checks the one-time state of the sign-in.
        // An instance that is not running has lost that state, so the owner goes to the page instead.
        if (context.req.method === 'GET' && context.req.path === APP_OAUTH_CALLBACK_PATH) {
            const callbackStatus = await options.instances.status(name)
                .catch(() => undefined);
            const callbackResponse = callbackStatus === 'running'
                ? await proxyRequest(context, person, options)
                        .catch(() => undefined)
                : undefined;

            return callbackResponse ?? context.redirect('/', 303);
        }

        const currentTime = nowFor(options);
        const session = readHubSession(context, options.sessions, currentTime, options.secure);

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

        // Opens one of the person's shared groups. The group's address trades the ticket for a session of this person.
        const groupOpenMatch = GROUP_OPEN_PATH_PATTERN.exec(context.req.path);

        if (groupOpenMatch !== null && context.req.method === 'GET') {
            return openGroup(context, options, name, groupOpenMatch[1] ?? '', hostHeader);
        }

        return serveInstance(context, person, options, serving, { name });
    });

    return app;
}

export { createFrontDoorRoutes, requestHasSameOrigin };
export type { FrontDoorRoutesOptions, OwnerSetupOptions, UpstreamTarget };
