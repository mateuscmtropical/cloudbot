import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable, pipeline } from 'node:stream';

import type { Vault } from './Vault.ts';

const DEFAULT_UPSTREAM_URL = 'https://api.anthropic.com';
const LOOPBACK_HOST = '127.0.0.1';
const API_KEY_HEADER = 'x-api-key';
const DEFAULT_HTTP_METHOD = 'GET';
const BAD_GATEWAY_STATUS = 502;
const SERVICE_UNAVAILABLE_STATUS = 503;

// The agent sends no credentials of its own. The key comes from the vault.
// accept-encoding is dropped because fetch decodes compressed bodies, and the
// proxy streams the body back as it arrived, so the encoding header must go too.
const DROPPED_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-length',
    'accept-encoding',
    'authorization',
    API_KEY_HEADER,
]);
const DROPPED_RESPONSE_HEADERS = new Set([
    'connection',
    'keep-alive',
    'transfer-encoding',
    'content-encoding',
    'content-length',
]);

interface KeyProxyOptions {
    vault: Vault;
    secretName: string;
    upstreamUrl?: string;
    port?: number;
}

interface KeyProxy {
    url: string;
    close: () => Promise<void>;
}

interface ForwardTarget {
    vault: Vault;
    secretName: string;
    upstreamBase: string;
}

interface ProxyErrorResponse {
    error: string;
}

function buildRequestHeaders(incomingHeaders: IncomingHttpHeaders, apiKey: string): Record<string, string> {
    const forwardedHeaders: Record<string, string> = {};
    const headerEntries = Object.entries(incomingHeaders);

    headerEntries.forEach(([headerName, headerValue]) => {
        if (headerValue === undefined || DROPPED_REQUEST_HEADERS.has(headerName)) {
            return;
        }

        forwardedHeaders[headerName] = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
    });
    forwardedHeaders[API_KEY_HEADER] = apiKey;

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

async function readRequestBody(incomingRequest: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];

    // for await is the only loop left here: the request body is a stream, and array methods cannot wait on it.
    for await (const chunk of incomingRequest) {
        chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks);
}

function sendJsonError(outgoingResponse: ServerResponse, statusCode: number, message: string): void {
    const errorResponse: ProxyErrorResponse = { error: message };
    const errorBody = JSON.stringify(errorResponse);
    const headers = { 'content-type': 'application/json' };

    outgoingResponse.writeHead(statusCode, headers);
    outgoingResponse.end(errorBody);
}

async function forwardRequest(
    incomingRequest: IncomingMessage,
    outgoingResponse: ServerResponse,
    target: ForwardTarget,
    upstreamAbort: AbortController,
): Promise<void> {
    const apiKey = target.vault.get(target.secretName);

    if (apiKey === undefined) {
        sendJsonError(outgoingResponse, SERVICE_UNAVAILABLE_STATUS, `Secret ${target.secretName} is not in the vault.`);

        return;
    }

    const requestBody = await readRequestBody(incomingRequest);
    const requestUrl = new URL(incomingRequest.url ?? '/', target.upstreamBase);
    const requestHeaders = buildRequestHeaders(incomingRequest.headers, apiKey);
    const upstreamResponse = await fetch(requestUrl, {
        method: incomingRequest.method ?? DEFAULT_HTTP_METHOD,
        headers: requestHeaders,
        body: requestBody.length > 0 ? requestBody : null,
        // Redirects are passed back to the agent, so the key never goes to another host.
        redirect: 'manual',
        signal: upstreamAbort.signal,
    });
    const responseHeaders = buildResponseHeaders(upstreamResponse.headers);

    outgoingResponse.writeHead(upstreamResponse.status, responseHeaders);

    if (upstreamResponse.body === null) {
        outgoingResponse.end();

        return;
    }

    // pipeline, unlike pipe, reports the error when the upstream stream is aborted.
    const upstreamStream = Readable.fromWeb(upstreamResponse.body);

    pipeline(upstreamStream, outgoingResponse, (pipelineError) => {
        if (pipelineError && !upstreamAbort.signal.aborted) {
            console.error(`Key proxy stream failed: ${pipelineError.message}`);
        }
    });
}

async function forwardRequestSafely(
    incomingRequest: IncomingMessage,
    outgoingResponse: ServerResponse,
    target: ForwardTarget,
): Promise<void> {
    const upstreamAbort = new AbortController();

    // The agent went away before the response finished, so the upstream call is stopped to stop spending tokens.
    // A finished response also emits close, which is why writableFinished is checked.
    outgoingResponse.once('close', () => {
        if (!outgoingResponse.writableFinished) {
            upstreamAbort.abort();
        }
    });
    // IncomingMessage emits close after the body is read too, so only an incomplete body counts as a disconnect.
    incomingRequest.once('close', () => {
        if (!incomingRequest.complete) {
            upstreamAbort.abort();
        }
    });

    try {
        await forwardRequest(incomingRequest, outgoingResponse, target, upstreamAbort);
    } catch (error: unknown) {
        // Expected when the agent disconnected: the abort error is not a failure.
        if (upstreamAbort.signal.aborted) {
            return;
        }

        // Logs the message only. The request headers, which hold the key, are never printed.
        const errorMessage = error instanceof Error ? error.message : 'unknown error';

        console.error(`Key proxy request failed: ${errorMessage}`);

        if (outgoingResponse.headersSent) {
            outgoingResponse.destroy();

            return;
        }

        sendJsonError(outgoingResponse, BAD_GATEWAY_STATUS, 'The request to the upstream API failed.');
    }
}

async function startKeyProxy(options: KeyProxyOptions): Promise<KeyProxy> {
    const upstreamBase = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
    const target: ForwardTarget = {
        vault: options.vault,
        secretName: options.secretName,
        upstreamBase,
    };
    const server: Server = createServer((incomingRequest, outgoingResponse) => {
        void forwardRequestSafely(incomingRequest, outgoingResponse, target);
    });
    const port = options.port ?? 0;

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK_HOST, () => {
            resolve();
        });
    });

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('Key proxy did not get a TCP address.');
    }

    const url = `http://${LOOPBACK_HOST}:${String(address.port)}`;

    return {
        url,
        close: () => new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => {
                if (error) {
                    reject(error);

                    return;
                }

                resolve();
            });
        }),
    };
}

export { startKeyProxy };
export type { KeyProxy, KeyProxyOptions };
