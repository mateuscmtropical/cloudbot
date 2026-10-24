import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';

import { inputKeyOf } from '../agent/createLoopbackToolServer.ts';
import { pinnedFetch } from './pinnedFetch.ts';
import { BodyTooLargeError, readCapped } from './readCapped.ts';

// A remote MCP server behind the proxy. The token is read from the vault for each request, so it is held only while a request is sent.
interface AppRoute {
    upstream: URL;
    readToken: () => string | undefined | Promise<string | undefined>;
}

interface AppProxyOptions {
    // Refuses an address that is not allowed now, and returns the addresses it checked. It runs on every request.
    // The upstream request goes only to those addresses, so a changed DNS answer cannot reach a private host.
    checkUpstream: (url: URL) => Promise<string[]>;
}

// One turn's address for a connected server. Resource requests are refused, and a tool call is sent only when the
// engine allowed that exact call first, so a call that skipped the review never reaches the server.
interface ProxyCallGate {
    address: string;
    // Lets the server run this one call, once. The call id is the one the client sends in the call's _meta.callId.
    allowCall: (callId: string, toolName: string, input: unknown) => void;
    close: () => void;
}

interface GatedCall {
    toolName: string;
    inputKey: string;
    isConsumed: boolean;
}

interface GateState {
    routeKey: string;
    calls: Map<string, GatedCall>;
}

interface ProxyErrorResponse {
    error: string;
}

const LOOPBACK_HOST = '127.0.0.1';
const RANDOM_KEY_BYTES = 24;
const BAD_GATEWAY_STATUS = 502;
const NOT_FOUND_STATUS = 404;
const DEFAULT_HTTP_METHOD = 'POST';
const PAYLOAD_TOO_LARGE_STATUS = 413;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MIN_REDIRECT_STATUS = 300;
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const FORBIDDEN_STATUS = 403;
// On a gated address every MCP resource request is refused. Codex offers list_mcp_resources and read_mcp_resource
// with no approval whenever a server is configured (seen with codex-cli 0.163.0), so a Codex turn gets a gated address.
// Claude turns keep the plain address, where the CLI asks before reading a resource.
const RESOURCE_METHOD_PREFIX = 'resources/';
const TOOL_CALL_METHOD = 'tools/call';
const METHOD_NOT_FOUND_CODE = -32601;
const RESOURCES_BLOCKED_MESSAGE = 'Resources of connected servers are turned off for this bot.';
const CALL_NOT_ALLOWED_MESSAGE = 'This call was not approved, so it was not sent.';
const MAX_REDIRECT_STATUS = 399;

// The agent sends no credentials of its own. The proxy adds the token from the vault, and drops any header that could carry one.
const DROPPED_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'accept-encoding',
    'authorization',
    'cookie',
]);
const DROPPED_RESPONSE_HEADERS = new Set([
    'location',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-encoding',
    'content-length',
]);

function buildRequestHeaders(incomingHeaders: IncomingHttpHeaders, token: string | undefined): Record<string, string> {
    const forwardedHeaders: Record<string, string> = {};

    Object.entries(incomingHeaders)
        .forEach(([headerName, headerValue]) => {
            if (headerValue === undefined || DROPPED_REQUEST_HEADERS.has(headerName)) {
                return;
            }

            forwardedHeaders[headerName] = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
        });

    if (token !== undefined) {
        forwardedHeaders['authorization'] = `Bearer ${token}`;
    }

    return forwardedHeaders;
}

function buildResponseHeaders(upstreamHeaders: Headers): Record<string, string> {
    const responseHeaders: Record<string, string> = {};

    upstreamHeaders.forEach((headerValue, headerName) => {
        if (!DROPPED_RESPONSE_HEADERS.has(headerName)) {
            responseHeaders[headerName] = headerValue;
        }
    });

    return responseHeaders;
}

function sendJsonError(response: ServerResponse, statusCode: number, message: string): void {
    const errorResponse: ProxyErrorResponse = { error: message };

    response.writeHead(statusCode, { 'content-type': 'application/json' });
    const errorBody = JSON.stringify(errorResponse);

    response.end(errorBody);
}

// The first path segment is the random key of the server. Any other path is refused.
function readRouteKey(requestUrl: string | undefined): string {
    const pathname = new URL(requestUrl ?? '/', `http://${LOOPBACK_HOST}`).pathname;

    return pathname.split('/')[1] ?? '';
}

function readGateKey(requestUrl: string | undefined): string | undefined {
    const pathname = new URL(requestUrl ?? '/', `http://${LOOPBACK_HOST}`).pathname;

    const segment = pathname.split('/')[2];

    return segment === '' ? undefined : segment;
}

function readMethod(message: unknown): unknown {
    return typeof message === 'object' && message !== null ? Reflect.get(message, 'method') : undefined;
}

type GateCheck = { kind: 'pass' } | { kind: 'unreadable' } | { kind: 'refused'; id: unknown; isBatch: boolean; message: string };

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Uses up the allowed call this tool call names. Anything that does not match one unused allowed call is refused.
function consumeGatedCall(gate: GateState, message: unknown): boolean {
    const rawParams: unknown = Reflect.get(message as object, 'params');
    const params = readRecord(rawParams);
    const meta = readRecord(params?._meta);
    const callId = meta?.callId;

    if (params === undefined || typeof callId !== 'string') {
        return false;
    }

    const call = gate.calls.get(callId);

    if (call === undefined || call.isConsumed || call.toolName !== params.name || call.inputKey !== inputKeyOf(params.arguments)) {
        return false;
    }

    call.isConsumed = true;

    return true;
}

// An empty body, such as the GET that opens an event stream, passes. A body that is not JSON cannot be checked, so it is refused.
function checkGatedRequest(body: Buffer, gate: GateState): GateCheck {
    if (body.length === 0) {
        return { kind: 'pass' };
    }

    let parsed: unknown;

    try {
        const text = body.toString('utf8');

        parsed = JSON.parse(text);
    } catch {
        return { kind: 'unreadable' };
    }

    const isBatch = Array.isArray(parsed);
    const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    const refusals = messages.map(message => refusalOf(message, gate, isBatch));
    const refusal = refusals.find(message => message !== undefined);

    if (refusal === undefined) {
        return { kind: 'pass' };
    }

    return { kind: 'refused', ...refusal, isBatch };
}

// Why one message of a gated request is refused, or undefined when it may be sent.
function refusalOf(message: unknown, gate: GateState, isBatch: boolean): { id: unknown; message: string } | undefined {
    const method = readMethod(message);
    const id: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'id') : undefined;

    if (typeof method === 'string' && method.startsWith(RESOURCE_METHOD_PREFIX)) {
        return { id, message: RESOURCES_BLOCKED_MESSAGE };
    }

    // A batch cannot be partly sent, so a tool call in a batch is refused as a whole. It never uses up an allowed call.
    if (method === TOOL_CALL_METHOD && (isBatch || !consumeGatedCall(gate, message))) {
        return { id, message: CALL_NOT_ALLOWED_MESSAGE };
    }

    return undefined;
}

// A single request gets a JSON-RPC error, so the client reports it as a failed call. A batch is refused as a whole.
function refuseGatedRequest(response: ServerResponse, check: { id: unknown; isBatch: boolean; message: string }): void {
    if (check.isBatch) {
        sendJsonError(response, FORBIDDEN_STATUS, check.message);

        return;
    }

    const isValidId = typeof check.id === 'string' || typeof check.id === 'number';
    const errorBody = JSON.stringify({ jsonrpc: '2.0', id: isValidId ? check.id : null, error: { code: METHOD_NOT_FOUND_CODE, message: check.message } });

    response.writeHead(OK_STATUS, { 'content-type': 'application/json' });
    response.end(errorBody);
}

// Only the proxy process holds the token. The agent connects to 127.0.0.1 with a random key per server.
class AppProxy {
    private readonly checkUpstream: (url: URL) => Promise<string[]>;
    private readonly routes = new Map<string, AppRoute>();
    private readonly keysByAppId = new Map<string, string>();
    private readonly gates = new Map<string, GateState>();
    private server: Server | undefined;
    private baseUrl: string | undefined;

    constructor(options: AppProxyOptions) {
        this.checkUpstream = options.checkUpstream;
    }

    async start(): Promise<void> {
        const server = createServer((incomingRequest, outgoingResponse) => {
            this.handle(incomingRequest, outgoingResponse)
                .catch(() => {
                    // Once the headers are sent, a JSON error cannot be added. The response is cut off instead.
                    if (outgoingResponse.headersSent) {
                        outgoingResponse.destroy();

                        return;
                    }

                    sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, 'The server could not be reached.');
                });
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, LOOPBACK_HOST, () => {
                resolve();
            });
        });

        const address = server.address() as AddressInfo;

        this.server = server;
        this.baseUrl = `http://${LOOPBACK_HOST}:${String(address.port)}`;
    }

    // Returns the address the agent connects to for this server. It replaces any earlier address of the same server.
    register(appId: string, route: AppRoute): string {
        const baseUrl = this.requireBaseUrl();
        const previousKey = this.keysByAppId.get(appId);

        if (previousKey !== undefined) {
            this.routes.delete(previousKey);
        }

        const key = randomBytes(RANDOM_KEY_BYTES)
            .toString('hex');

        this.routes.set(key, route);
        this.keysByAppId.set(appId, key);

        return `${baseUrl}/${key}`;
    }

    // The address already registered for a server, or undefined when it has none.
    addressOf(appId: string): string | undefined {
        const key = this.keysByAppId.get(appId);

        return key === undefined ? undefined : `${this.requireBaseUrl()}/${key}`;
    }

    // A gated address of a server for one turn, or undefined when the address is not one this proxy gave out.
    openCallGate(address: string): ProxyCallGate | undefined {
        const baseUrl = this.requireBaseUrl();
        const prefix = `${baseUrl}/`;
        const routeKey = address.startsWith(prefix) ? address.slice(prefix.length) : '';

        if (!this.routes.has(routeKey)) {
            return undefined;
        }

        const gateKey = randomBytes(RANDOM_KEY_BYTES)
            .toString('hex');
        const gate: GateState = { routeKey, calls: new Map() };

        this.gates.set(gateKey, gate);

        return {
            address: `${address}/${gateKey}`,
            allowCall: (callId: string, toolName: string, input: unknown): void => {
                // An id that is known already keeps its first state, so a second allow cannot reopen a used call.
                if (!gate.calls.has(callId)) {
                    gate.calls.set(callId, { toolName, inputKey: inputKeyOf(input), isConsumed: false });
                }
            },
            close: (): void => {
                this.gates.delete(gateKey);
            },
        };
    }

    remove(appId: string): void {
        const key = this.keysByAppId.get(appId);

        if (key !== undefined) {
            this.routes.delete(key);
            this.keysByAppId.delete(appId);
        }
    }

    async close(): Promise<void> {
        const server = this.server;

        if (server === undefined) {
            return;
        }

        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    }

    private requireBaseUrl(): string {
        if (this.baseUrl === undefined) {
            throw new Error('The app proxy has not started.');
        }

        return this.baseUrl;
    }

    private async handle(incomingRequest: IncomingMessage, outgoingResponse: ServerResponse): Promise<void> {
        const routeKey = readRouteKey(incomingRequest.url);
        const route = this.routes.get(routeKey);

        const gateKey = readGateKey(incomingRequest.url);
        const gate = gateKey === undefined ? undefined : this.gates.get(gateKey);

        // A path past the key must name an open gate of this server. Anything else is refused, never sent ungated.
        if (route === undefined || (gateKey !== undefined && gate?.routeKey !== routeKey)) {
            sendJsonError(outgoingResponse, NOT_FOUND_STATUS, 'No connected server has this address.');

            return;
        }

        let addresses: string[];

        try {
            addresses = await this.checkUpstream(route.upstream);
        } catch {
            sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, 'That server address is not allowed now.');

            return;
        }

        // A declared length over the cap is refused before anything is read.
        const declaredLength = Number(incomingRequest.headers['content-length'] ?? '0');

        if (declaredLength > MAX_REQUEST_BYTES) {
            sendJsonError(outgoingResponse, PAYLOAD_TOO_LARGE_STATUS, 'The request is too large.');

            return;
        }

        let requestBody: Buffer;

        try {
            requestBody = await readCapped(incomingRequest, MAX_REQUEST_BYTES);
        } catch (error: unknown) {
            if (error instanceof BodyTooLargeError) {
                sendJsonError(outgoingResponse, PAYLOAD_TOO_LARGE_STATUS, 'The request is too large.');

                return;
            }

            throw error;
        }

        if (gate !== undefined) {
            const check = checkGatedRequest(requestBody, gate);

            if (check.kind === 'unreadable') {
                sendJsonError(outgoingResponse, BAD_REQUEST_STATUS, 'The request is not JSON, so it was not sent.');

                return;
            }

            if (check.kind === 'refused') {
                refuseGatedRequest(outgoingResponse, check);

                return;
            }
        }

        let token: string | undefined;

        try {
            token = await route.readToken();
        } catch {
            // The token is not sent when it cannot be used for this address, such as a changed site or a plain http address.
            sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, 'The token for this server cannot be used now, so the request was not sent.');

            return;
        }

        const requestHeaders = buildRequestHeaders(incomingRequest.headers, token);
        // Redirects are not followed, so a redirect goes back to the agent and the token never goes to another address.
        const upstreamRequest: RequestInit = {
            method: incomingRequest.method ?? DEFAULT_HTTP_METHOD,
            headers: requestHeaders,
            body: requestBody.length > 0 ? requestBody : null,
            redirect: 'manual',
        };
        const upstreamResponse = await pinnedFetch(route.upstream, upstreamRequest, addresses);

        // A redirect is not passed on. The agent would send its next request to an address that was never checked.
        if (upstreamResponse.status >= MIN_REDIRECT_STATUS && upstreamResponse.status <= MAX_REDIRECT_STATUS) {
            await upstreamResponse.body?.cancel();
            sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, 'The server tried to redirect.');

            return;
        }

        const responseHeaders = buildResponseHeaders(upstreamResponse.headers);

        outgoingResponse.writeHead(upstreamResponse.status, responseHeaders);

        if (upstreamResponse.body === null) {
            outgoingResponse.end();

            return;
        }

        const upstreamStream = Readable.fromWeb(upstreamResponse.body);

        pipeline(upstreamStream, outgoingResponse, () => {
            // A stream that ends early is the agent or the server going away. Nothing else to report.
        });
    }
}

export { AppProxy };
export type { AppProxyOptions, AppRoute, ProxyCallGate };
