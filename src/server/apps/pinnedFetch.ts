import { request as requestHttp } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';

import { createPinnedLookup } from '../watches/fetchWatchedPage.ts';

// Statuses that Node cannot send with a body, so the Response has none.
const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];
const CONNECT_TIMEOUT_MS = 15 * 1000;
// Time to the response headers only. The timer stops when they arrive, so a long stream of body is not cut.
const HEADER_TIMEOUT_MS = 30 * 1000;
const MIN_STATUS = 200;
const MAX_STATUS = 599;

function toHeaders(incoming: IncomingHttpHeaders): Headers {
    const headers = new Headers();

    Object.entries(incoming)
        .forEach(([headerName, headerValue]) => {
            const values = Array.isArray(headerValue) ? headerValue : [headerValue];

            values.forEach((value) => {
                if (value !== undefined) {
                    headers.append(headerName, value);
                }
            });
        });

    return headers;
}

function toResponse(response: IncomingMessage): Response {
    const status = response.statusCode ?? 0;
    const body = NULL_BODY_STATUSES.includes(status) ? null : Readable.toWeb(response);

    return new Response(body, { status, headers: toHeaders(response.headers) });
}

// Sends one request to the checked addresses only, with the real host name for SNI and Host. The socket lookup is the
// pinned one from page watches, so a second DNS answer cannot move the connection. Redirects are not followed.
// Only the connect has a timeout. A stream may stay open for a long time, since MCP can send server-sent events.
function pinnedFetch(url: URL, init: RequestInit, addresses: string[]): Promise<Response> {
    return new Promise((resolve, reject) => {
        const send = url.protocol === 'https:' ? requestHttps : requestHttp;
        const requestHeaders = new Headers(init.headers);
        const plainHeaders: Record<string, string> = { 'accept-encoding': 'identity' };
        const lookup = createPinnedLookup(addresses);
        const body = typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : undefined;

        requestHeaders.forEach((value, name) => {
            plainHeaders[name] = value;
        });

        const request = send(url, { method: init.method ?? 'GET', headers: plainHeaders, lookup }, (response: IncomingMessage) => {
            const status = response.statusCode ?? 0;

            if (status < MIN_STATUS || status > MAX_STATUS) {
                response.resume();
                reject(new Error('The server answered with an unusual status.'));

                return;
            }

            clearTimeout(headerTimer);
            const pageResponse = toResponse(response);

            resolve(pageResponse);
        });

        const connectTimer = setTimeout(() => {
            request.destroy(new Error('The connection took too long.'));
        }, CONNECT_TIMEOUT_MS);

        const headerTimer = setTimeout(() => {
            request.destroy(new Error('The server took too long to answer.'));
        }, HEADER_TIMEOUT_MS);

        request.on('socket', (socket) => {
            socket.once('connect', () => {
                clearTimeout(connectTimer);
            });
        });
        request.on('close', () => {
            clearTimeout(connectTimer);
            clearTimeout(headerTimer);
        });
        request.on('error', reject);

        if (init.signal?.aborted === true) {
            request.destroy(new Error('The request was aborted.'));
        }

        init.signal?.addEventListener('abort', () => {
            request.destroy(new Error('The request was aborted.'));
        }, { once: true });

        request.end(body);
    });
}

export { pinnedFetch };
