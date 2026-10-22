import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppProxy } from './AppProxy.ts';

// A stand-in MCP server. It records the headers of each request and echoes the body back.
interface Upstream {
    server: Server;
    url: URL;
    received: { headers: IncomingHttpHeaders; body: string }[];
}

async function startUpstream(): Promise<Upstream> {
    const received: Upstream['received'] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        request.on('end', () => {
            const body = Buffer.concat(chunks)
                .toString('utf8');

            received.push({ headers: request.headers, body });
            response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
            response.end(body);
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });

    const address = server.address() as AddressInfo;

    return { server, url: new URL(`http://127.0.0.1:${String(address.port)}/mcp`), received };
}

describe('AppProxy', () => {
    let upstream: Upstream;
    let proxy: AppProxy;

    beforeEach(async () => {
        upstream = await startUpstream();
        proxy = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });
        await proxy.start();
    });

    afterEach(async () => {
        await proxy.close();
        await new Promise<void>((resolve) => {
            upstream.server.close(() => {
                resolve();
            });
        });
    });

    it('forwards a request with the token from the vault, and drops any token the agent sent', async () => {
        const address = proxy.register('app-1', { upstream: upstream.url, readToken: () => 'vault-token' });
        const response = await fetch(address, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer agent-guess' },
            body: '{"jsonrpc":"2.0"}',
        });

        expect(await response.text())
            .toBe('{"jsonrpc":"2.0"}');
        expect(response.headers.get('mcp-session-id'))
            .toBe('session-1');
        expect(upstream.received[0]?.headers['authorization'])
            .toBe('Bearer vault-token');
    });

    it('sends no authorization header for a server without a token', async () => {
        const address = proxy.register('app-2', { upstream: upstream.url, readToken: () => undefined });

        await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

        expect(upstream.received[0]?.headers['authorization'])
            .toBeUndefined();
    });

    it('answers 404 for a key that is not registered', async () => {
        const response = await fetch(`${proxy.register('app-3', { upstream: upstream.url, readToken: () => undefined })
            .replace(/\/[^/]+$/, '')}/unknown-key`, {
            method: 'POST',
            body: '{}',
        });

        expect(response.status)
            .toBe(404);
        expect(upstream.received)
            .toHaveLength(0);
    });

    it('refuses the request when the address is not allowed now, and never calls the server', async () => {
        const refusing = new AppProxy({ checkUpstream: () => Promise.reject(new Error('private')) });

        await refusing.start();

        const address = refusing.register('app-4', { upstream: upstream.url, readToken: () => 'vault-token' });
        const response = await fetch(address, { method: 'POST', body: '{}' });

        expect(response.status)
            .toBe(502);
        expect(upstream.received)
            .toHaveLength(0);
        await refusing.close();
    });

    it('connects to the checked address only, so a name that resolves elsewhere later is not used', async () => {
        // The .invalid name never resolves, so the request can only reach the server through the checked address.
        const pinnedUrl = new URL(`http://rebind.invalid:${upstream.url.port}/mcp`);
        const pinned = new AppProxy({ checkUpstream: () => Promise.resolve(['127.0.0.1']) });

        await pinned.start();

        const address = pinned.register('app-6', { upstream: pinnedUrl, readToken: () => 'vault-token' });
        const response = await fetch(address, { method: 'POST', body: '{"ok":true}' });

        expect(response.status)
            .toBe(200);
        expect(upstream.received[0]?.headers['host'])
            .toBe(`rebind.invalid:${upstream.url.port}`);
        await pinned.close();
    });

    it('cuts the stream off when the server fails after the headers were sent, and keeps serving', async () => {
        const broken = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.write('data: first\n\n');
            setTimeout(() => {
                response.destroy();
            }, 100);
        });

        await new Promise<void>((resolve) => {
            broken.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });

        const brokenPort = (broken.address() as AddressInfo).port;
        const brokenUrl = new URL(`http://127.0.0.1:${String(brokenPort)}/mcp`);
        const address = proxy.register('app-7', { upstream: brokenUrl, readToken: () => undefined });
        const response = await fetch(address, { method: 'POST', body: '{}' });

        expect(response.status)
            .toBe(200);
        await expect(response.text())
            .rejects.toThrow();

        const healthy = proxy.register('app-8', { upstream: upstream.url, readToken: () => undefined });
        const next = await fetch(healthy, { method: 'POST', body: '{"next":1}' });

        expect(await next.text())
            .toBe('{"next":1}');
        await new Promise<void>((resolve) => {
            broken.close(() => {
                resolve();
            });
        });
    });

    it('replaces the address of a server that is registered again, and forgets a removed one', async () => {
        const first = proxy.register('app-5', { upstream: upstream.url, readToken: () => undefined });
        const second = proxy.register('app-5', { upstream: upstream.url, readToken: () => undefined });

        expect(first)
            .not.toBe(second);

        const stale = await fetch(first, { method: 'POST', body: '{}' });

        expect(stale.status)
            .toBe(404);

        proxy.remove('app-5');

        const removed = await fetch(second, { method: 'POST', body: '{}' });

        expect(removed.status)
            .toBe(404);
    });

    it('answers 502 for a redirect and passes no location on, so the agent never reaches an unchecked address', async () => {
        const redirecting = createServer((_request, response) => {
            response.writeHead(302, { location: 'https://evil.invalid/steal' });
            response.end();
        });

        await new Promise<void>((resolve) => {
            redirecting.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });

        const port = (redirecting.address() as AddressInfo).port;
        const address = proxy.register('app-9', { upstream: new URL(`http://127.0.0.1:${String(port)}/mcp`), readToken: () => undefined });
        const response = await fetch(address, { method: 'POST', body: '{}' });

        expect(response.status)
            .toBe(502);
        expect(response.headers.get('location'))
            .toBeNull();
        expect(await response.text())
            .toContain('The server tried to redirect.');
        await new Promise<void>((resolve) => {
            redirecting.close(() => {
                resolve();
            });
        });
    });

    it('answers 502 and sends nothing upstream when the token cannot be used for the address', async () => {
        const address = proxy.register('app-10', {
            upstream: upstream.url,
            readToken: () => {
                throw new Error('The saved secret is for another site, so it is not sent here.');
            },
        });
        const response = await fetch(address, { method: 'POST', body: '{}' });

        expect(response.status)
            .toBe(502);
        expect(await response.text())
            .not.toContain('another site');
        expect(upstream.received)
            .toHaveLength(0);
    });

    it('answers 413 for a request body over 4 MB, before the body is read', async () => {
        const address = proxy.register('app-11', { upstream: upstream.url, readToken: () => undefined });
        const status = await new Promise<number>((resolve, reject) => {
            const clientRequest = httpRequest(address, { method: 'POST', headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }, (response) => {
                resolve(response.statusCode ?? 0);
                response.resume();
            });

            clientRequest.on('error', reject);
            clientRequest.end();
        });

        expect(status)
            .toBe(413);
        expect(upstream.received)
            .toHaveLength(0);
    });

    describe('the gated address of a turn', () => {
        function openGate(appId: string): NonNullable<ReturnType<AppProxy['openCallGate']>> {
            const gate = proxy.openCallGate(proxy.register(appId, { upstream: upstream.url, readToken: () => undefined }));

            if (gate === undefined) {
                throw new Error('No gate.');
            }

            return gate;
        }

        function toolCall(callId: string | undefined, name: string, args: unknown): string {
            const meta = callId === undefined ? {} : { _meta: { callId } };

            return JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args, ...meta } });
        }

        it('refuses a resource request before it reaches the server', async () => {
            const gate = openGate('app-r1');
            const response = await fetch(gate.address, { method: 'POST', body: '{"jsonrpc":"2.0","id":7,"method":"resources/read","params":{"uri":"file:///etc/passwd"}}' });

            expect(response.status)
                .toBe(200);
            expect(await response.json())
                .toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Resources of connected servers are turned off for this bot.' } });
            expect(upstream.received)
                .toHaveLength(0);
        });

        it('refuses the resource list and templates too', async () => {
            const gate = openGate('app-r2');
            const methods = ['resources/list', 'resources/templates/list', 'resources/subscribe'];
            const sends = methods.map(method => fetch(gate.address, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) }));

            await Promise.all(sends);
            expect(upstream.received)
                .toHaveLength(0);
        });

        it('refuses a whole batch that holds a resource request or a tool call', async () => {
            const gate = openGate('app-r3');

            gate.allowCall('call-1', 'search', {});

            const withResource = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'resources/read' }]);
            const withCall = `[${toolCall('call-1', 'search', {})}]`;
            const responses = await Promise.all([withResource, withCall].map(body => fetch(gate.address, { method: 'POST', body })));

            expect(responses.map(response => response.status))
                .toEqual([403, 403]);
            expect(upstream.received)
                .toHaveLength(0);
        });

        it('refuses a body that is not JSON', async () => {
            const gate = openGate('app-r4');
            const response = await fetch(gate.address, { method: 'POST', body: 'resources/read' });

            expect(response.status)
                .toBe(400);
            expect(upstream.received)
                .toHaveLength(0);
        });

        it('sends an allowed tool call once and refuses a repeat', async () => {
            const gate = openGate('app-r5');

            gate.allowCall('call-1', 'search', { query: 'a' });

            const first = await fetch(gate.address, { method: 'POST', body: toolCall('call-1', 'search', { query: 'a' }) });
            const second = await fetch(gate.address, { method: 'POST', body: toolCall('call-1', 'search', { query: 'a' }) });

            expect(await first.text())
                .toBe(toolCall('call-1', 'search', { query: 'a' }));
            expect(await second.json())
                .toMatchObject({ id: 3, error: { message: 'This call was not approved, so it was not sent.' } });
            expect(upstream.received)
                .toHaveLength(1);
        });

        it('refuses a tool call that was not allowed, or that differs from the allowed one', async () => {
            const gate = openGate('app-r6');

            gate.allowCall('call-1', 'search', { query: 'a' });

            const bodies = [
                toolCall(undefined, 'search', { query: 'a' }),
                toolCall('call-2', 'search', { query: 'a' }),
                toolCall('call-1', 'delete', { query: 'a' }),
                toolCall('call-1', 'search', { query: 'b' }),
            ];

            const sends = bodies.map(body => fetch(gate.address, { method: 'POST', body }));

            await Promise.all(sends);

            expect(upstream.received)
                .toHaveLength(0);
        });

        it('forwards other requests', async () => {
            const gate = openGate('app-r7');
            const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
            const response = await fetch(gate.address, { method: 'POST', body });

            expect(await response.text())
                .toBe(body);
            expect(upstream.received)
                .toHaveLength(1);
        });

        it('refuses everything on a closed gate or a gate key it never gave out', async () => {
            const gate = openGate('app-r8');

            gate.allowCall('call-1', 'search', {});
            gate.close();

            const plain = proxy.addressOf('app-r8') ?? '';
            const closed = await fetch(gate.address, { method: 'POST', body: toolCall('call-1', 'search', {}) });
            const madeUp = await fetch(`${plain}/abc`, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' });

            expect([closed.status, madeUp.status])
                .toEqual([404, 404]);
            expect(upstream.received)
                .toHaveLength(0);
        });

        it('opens no gate for an address it did not give out', () => {
            proxy.register('app-r9', { upstream: upstream.url, readToken: () => undefined });

            expect(proxy.openCallGate('http://127.0.0.1:1/unknown'))
                .toBeUndefined();
        });

        it('leaves the plain address unchanged for a resource request and a tool call', async () => {
            const address = proxy.register('app-r10', { upstream: upstream.url, readToken: () => undefined });

            await fetch(address, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' });
            await fetch(address, { method: 'POST', body: toolCall(undefined, 'search', {}) });
            expect(upstream.received)
                .toHaveLength(2);
        });
    });
});
