import { createServer, request } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startKeyProxy } from './KeyProxy.ts';
import type { KeyProxy } from './KeyProxy.ts';
import { Vault } from './Vault.ts';

interface ReceivedRequest {
    headers: IncomingHttpHeaders;
    body: string;
}

function getListeningPort(server: Server): number {
    const address = server.address() as AddressInfo;

    return address.port;
}

describe('startKeyProxy', () => {
    let folderPath: string;
    let upstreamServer: Server;
    let upstreamUrl: string;
    let receivedRequests: ReceivedRequest[];
    let proxy: KeyProxy | undefined;

    beforeEach(async () => {
        folderPath = mkdtempSync(join(tmpdir(), 'cloudbot-key-proxy-'));
        receivedRequests = [];
        upstreamServer = createServer((incomingRequest, outgoingResponse) => {
            const chunks: Buffer[] = [];

            incomingRequest.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
            });
            incomingRequest.on('end', () => {
                const requestBody = Buffer.concat(chunks)
                    .toString('utf8');

                receivedRequests.push({ headers: incomingRequest.headers, body: requestBody });
                outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });
                outgoingResponse.write('event: message\ndata: first\n\n');
                outgoingResponse.end('data: second\n\n');
            });
        });

        await new Promise<void>((resolve) => {
            upstreamServer.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });
        upstreamUrl = `http://127.0.0.1:${String(getListeningPort(upstreamServer))}`;
    });

    afterEach(async () => {
        await proxy?.close();
        proxy = undefined;
        upstreamServer.closeAllConnections();
        await new Promise<void>((resolve) => {
            upstreamServer.close(() => {
                resolve();
            });
        });
        rmSync(folderPath, { recursive: true, force: true });
    });

    it('adds the key from the vault, strips the agent credentials and streams the response', async () => {
        const vault = new Vault(folderPath);

        vault.set('ANTHROPIC_API_KEY', 'sk-ant-real');
        proxy = await startKeyProxy({ vault, secretName: 'ANTHROPIC_API_KEY', upstreamUrl, port: 0 });

        const response = await fetch(`${proxy.url}/v1/messages`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': 'dummy-key',
                'authorization': 'Bearer dummy-token',
            },
            body: '{"model":"test"}',
        });

        expect(proxy.url)
            .toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect(response.status)
            .toBe(200);
        expect(await response.text())
            .toBe('event: message\ndata: first\n\ndata: second\n\n');
        expect(receivedRequests)
            .toHaveLength(1);
        expect(receivedRequests[0]?.headers['x-api-key'])
            .toBe('sk-ant-real');
        expect(receivedRequests[0]?.headers.authorization)
            .toBeUndefined();
        expect(receivedRequests[0]?.body)
            .toBe('{"model":"test"}');
    });

    it('answers 503 with a JSON error when the secret is missing', async () => {
        const vault = new Vault(folderPath);

        proxy = await startKeyProxy({ vault, secretName: 'ANTHROPIC_API_KEY', upstreamUrl, port: 0 });

        const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
        const responseBody = await response.json() as { error: string };

        expect(response.status)
            .toBe(503);
        expect(responseBody.error)
            .toContain('ANTHROPIC_API_KEY');
        expect(receivedRequests)
            .toHaveLength(0);
    });

    it('aborts the upstream request when the agent disconnects mid-stream', async () => {
        const vault = new Vault(folderPath);

        vault.set('ANTHROPIC_API_KEY', 'sk-ant-real');

        let markUpstreamClosed: () => void = () => undefined;
        const upstreamClosed = new Promise<void>((resolve) => {
            markUpstreamClosed = resolve;
        });
        const slowUpstream = createServer((_incomingRequest, outgoingResponse) => {
            outgoingResponse.writeHead(200, { 'content-type': 'text/event-stream' });

            const streamTimer = setInterval(() => {
                outgoingResponse.write('data: tick\n\n');
            }, 20);

            outgoingResponse.on('close', () => {
                clearInterval(streamTimer);
                markUpstreamClosed();
            });
        });

        await new Promise<void>((resolve) => {
            slowUpstream.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });

        const slowUpstreamUrl = `http://127.0.0.1:${String(getListeningPort(slowUpstream))}`;
        const slowProxy = await startKeyProxy({ vault, secretName: 'ANTHROPIC_API_KEY', upstreamUrl: slowUpstreamUrl, port: 0 });
        const clientRequest = request(`${slowProxy.url}/v1/messages`, { method: 'POST' });

        clientRequest.on('error', () => undefined);
        clientRequest.on('response', (response) => {
            response.once('data', () => {
                clientRequest.destroy();
            });
        });
        clientRequest.end('{}');

        await upstreamClosed;
        slowUpstream.closeAllConnections();
        await slowProxy.close();
        await new Promise<void>((resolve) => {
            slowUpstream.close(() => {
                resolve();
            });
        });
    });
});
