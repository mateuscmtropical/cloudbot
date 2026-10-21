import { describe, expect, it } from 'vitest';

import { probeAppServer } from './probeAppServer.ts';
import type { FetchFunction } from './probeAppServer.ts';

const URL_TEXT = 'https://mcp.example.com/mcp';

interface SentRequest {
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

// Answers the three requests of the handshake in order: initialize, initialized, tools/list.
function serverWith(options: { initializeStatus?: number; toolsResult?: unknown; asStream?: boolean }): { fetch: FetchFunction; sent: SentRequest[] } {
    const sent: SentRequest[] = [];
    const respond = (init: RequestInit): Response => {
        const rawBody = typeof init.body === 'string' ? init.body : '{}';
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        const headers = init.headers as Record<string, string>;

        sent.push({ body, headers });

        if (body['method'] === 'initialize') {
            if (options.initializeStatus !== undefined) {
                return new Response('denied', { status: options.initializeStatus });
            }

            return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }), {
                status: 200,
                headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-7' },
            });
        }

        if (body['method'] === 'notifications/initialized') {
            return new Response(null, { status: 202 });
        }

        const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, result: options.toolsResult ?? { tools: [{ name: 'a' }, { name: 'b' }] } });

        if (options.asStream === true) {
            return new Response(`event: message\ndata: ${payload}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }

        return new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const fetchFunction: FetchFunction = (_url, init) => Promise.resolve(respond(init));

    return { fetch: fetchFunction, sent };
}

describe('probeAppServer', () => {
    it('counts the tools of a server that answers with JSON', async () => {
        const server = serverWith({});

        expect(await probeAppServer(URL_TEXT, undefined, server.fetch))
            .toEqual({ status: 'connected', toolCount: 2 });
    });

    it('reads the tools from a server-sent event stream', async () => {
        const server = serverWith({ asStream: true, toolsResult: { tools: [{ name: 'a' }] } });

        expect(await probeAppServer(URL_TEXT, undefined, server.fetch))
            .toEqual({ status: 'connected', toolCount: 1 });
    });

    it('sends the session id back and the token only as a bearer header', async () => {
        const server = serverWith({});

        await probeAppServer(URL_TEXT, 'tok-123', server.fetch);

        const toolsRequest = server.sent.find(request => request.body['method'] === 'tools/list');

        expect(toolsRequest?.headers['mcp-session-id'])
            .toBe('session-7');
        expect(toolsRequest?.headers['authorization'])
            .toBe('Bearer tok-123');
    });

    it('asks for a token when the server refuses without one', async () => {
        expect(await probeAppServer(URL_TEXT, undefined, serverWith({ initializeStatus: 401 }).fetch))
            .toEqual({ status: 'needs_token' });
    });

    it('reports a refused token without repeating it', async () => {
        const result = await probeAppServer(URL_TEXT, 'tok-123', serverWith({ initializeStatus: 403 }).fetch);

        expect(result)
            .toEqual({ status: 'failed', problem: 'The server refused the token.' });
        expect(JSON.stringify(result))
            .not.toContain('tok-123');
    });

    it('fails on a page that is not an MCP server', async () => {
        const notMcp: FetchFunction = () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));

        expect(await probeAppServer(URL_TEXT, undefined, notMcp))
            .toEqual({ status: 'failed', problem: 'The server did not answer like an MCP server.' });
    });

    it('fails when the request cannot be sent', async () => {
        const broken: FetchFunction = () => Promise.reject(new Error('connect ECONNREFUSED'));

        expect(await probeAppServer(URL_TEXT, undefined, broken))
            .toEqual({ status: 'failed', problem: 'The server could not be reached.' });
    });

    it('gives up on a reply over 1 MB, so the probe cannot hold a large body', async () => {
        const big = 'x'.repeat(1024 * 1024 + 1);
        const oversized: FetchFunction = () => Promise.resolve(new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }));

        expect(await probeAppServer(URL_TEXT, undefined, oversized))
            .toEqual({ status: 'failed', problem: 'The server could not be reached.' });
    });
});
