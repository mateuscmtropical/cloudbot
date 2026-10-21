import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { isPublicAddress } from '../watches/publicAddress.ts';
import { BrowserGate, createRefusalThrottle } from './BrowserGate.ts';
import type { BrowserGateOptions } from './BrowserGate.ts';

interface StartedGate {
    gate: BrowserGate;
    logs: string[];
}

interface EchoServer {
    port: number;
    connections: () => number;
}

interface GateWithServer {
    server: Server | undefined;
}

const GREETING = Buffer.from([5, 1, 0]);
const REPLY_SUCCEEDED = 0;
const REPLY_HOST_UNREACHABLE = 4;
const REPLY_NOT_ALLOWED = 2;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_NOT_SUPPORTED = 8;
const CONNECT_COMMAND = 1;
const BIND_COMMAND = 2;
const ADDRESS_IPV4 = 1;
const ADDRESS_DOMAIN = 3;
const ADDRESS_IPV6 = 4;

const gates: BrowserGate[] = [];
const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(gates.splice(0)
        .map(gate => gate.close()));
    await Promise.all(servers.splice(0)
        .map(server => new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        })));
});

// Reads exactly `count` bytes from the socket.
function readBytes(socket: Socket, count: number): Promise<Buffer> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        const onData = (chunk: Buffer): void => {
            chunks.push(chunk);
            total += chunk.length;

            if (total >= count) {
                socket.off('data', onData);
                resolve(Buffer.concat(chunks)
                    .subarray(0, count));
            }
        };

        socket.on('data', onData);
    });
}

async function startEchoServer(): Promise<EchoServer> {
    let connectionCount = 0;
    const server = createServer((socket) => {
        connectionCount += 1;
        socket.on('error', () => undefined);
        socket.pipe(socket);
    });

    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address() as AddressInfo;

    return { port: address.port, connections: () => connectionCount };
}

async function startGate(options: BrowserGateOptions = {}): Promise<StartedGate> {
    const logs: string[] = [];
    const gate = new BrowserGate({
        port: 0,
        log: line => logs.push(line),
        ...options,
    });

    gates.push(gate);
    await gate.start();

    return { gate, logs };
}

function portBytes(port: number): number[] {
    const high = port >> 8;
    const low = port & 255;

    return [high, low];
}

function domainRequest(name: string, port: number, command = CONNECT_COMMAND): Buffer {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.from([5, command, 0, ADDRESS_DOMAIN, nameBytes.length]);
    const trailer = Buffer.from(portBytes(port));

    return Buffer.concat([header, nameBytes, trailer]);
}

function ipv4Request(address: string, port: number): Buffer {
    const octets = address.split('.')
        .map(octet => Number.parseInt(octet, 10));
    const header = Buffer.from([5, CONNECT_COMMAND, 0, ADDRESS_IPV4, ...octets]);

    return Buffer.concat([header, Buffer.from(portBytes(port))]);
}

function ipv6LoopbackRequest(port: number): Buffer {
    const address = Buffer.alloc(16);

    address[15] = 1;

    const header = Buffer.from([5, CONNECT_COMMAND, 0, ADDRESS_IPV6]);

    return Buffer.concat([header, address, Buffer.from(portBytes(port))]);
}

// Greets the gate, sends the request and returns the reply code with the open socket.
async function sendRequest(gatePort: number, request: Buffer): Promise<{ replyCode: number; socket: Socket }> {
    const socket = connect({ host: '127.0.0.1', port: gatePort });

    await once(socket, 'connect');
    socket.write(GREETING);

    const greetingReply = await readBytes(socket, 2);

    expect([...greetingReply])
        .toEqual([5, 0]);

    const replyReading = readBytes(socket, 10);

    socket.write(request);

    const reply = await replyReading;

    return { replyCode: reply[1] ?? -1, socket };
}

function waitForClose(socket: Socket): Promise<void> {
    return new Promise((resolve) => {
        socket.once('close', () => {
            resolve();
        });
    });
}

describe('BrowserGate', () => {
    it('connects a public name and pipes bytes both ways', async () => {
        const echo = await startEchoServer();
        const { gate } = await startGate({
            resolve: () => Promise.resolve(['127.0.0.1']),
            isPublic: () => true,
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('public.test', echo.port));

        expect(replyCode)
            .toBe(REPLY_SUCCEEDED);

        socket.write('hello');

        const echoed = await readBytes(socket, 5);

        expect(echoed.toString('utf8'))
            .toBe('hello');
        socket.destroy();
    });

    it('refuses a private IP address literal with reply 2 and logs only the host and port', async () => {
        const echo = await startEchoServer();
        const { gate, logs } = await startGate({
            isPublic: address => isPublicAddress(address, []),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, ipv4Request('127.0.0.1', echo.port));
        const closed = waitForClose(socket);

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        await closed;
        expect(echo.connections())
            .toBe(0);
        expect(logs)
            .toHaveLength(1);
        expect(logs[0])
            .toContain(`127.0.0.1:${String(echo.port)}`);
    });

    it('refuses a private IPv6 address literal with reply 2', async () => {
        const { gate } = await startGate({
            isPublic: address => isPublicAddress(address, []),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, ipv6LoopbackRequest(80));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
    });

    it('refuses a name that resolves to a private address', async () => {
        const { gate } = await startGate({
            resolve: () => Promise.resolve(['10.0.0.5']),
            isPublic: address => isPublicAddress(address, []),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('intranet.test', 80));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
    });

    it('refuses localhost by name', async () => {
        const { gate } = await startGate({
            isPublic: address => isPublicAddress(address, []),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('localhost', 80));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
    });

    it('refuses a name whose answers mix a public and a private address, and never connects', async () => {
        const echo = await startEchoServer();
        const { gate } = await startGate({
            resolve: () => Promise.resolve(['93.184.216.34', '127.0.0.1']),
            isPublic: address => address !== '127.0.0.1',
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('rebind.test', echo.port));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        expect(echo.connections())
            .toBe(0);
        socket.destroy();
    });

    it('lets a private host through when the owner allowed it, and still resolves it', async () => {
        const echo = await startEchoServer();
        const { gate } = await startGate({
            resolve: () => Promise.resolve(['127.0.0.1']),
            isPublic: () => false,
            isAllowablePrivate: () => true,
            isAllowed: (host, port) => Promise.resolve(host === 'intranet.test' && port === echo.port),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('intranet.test', echo.port));

        expect(replyCode)
            .toBe(REPLY_SUCCEEDED);

        socket.write('ok');

        const echoed = await readBytes(socket, 2);

        expect(echoed.toString('utf8'))
            .toBe('ok');
        socket.destroy();
    });

    it('still refuses a private host on a port the owner did not allow', async () => {
        const echo = await startEchoServer();
        const { gate } = await startGate({
            resolve: () => Promise.resolve(['127.0.0.1']),
            isPublic: () => false,
            isAllowed: (host, port) => Promise.resolve(host === 'intranet.test' && port === echo.port + 1),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('intranet.test', echo.port));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
    });

    it('refuses an allowed host that resolves to loopback, which is never allowed', async () => {
        const { gate, logs } = await startGate({
            resolve: () => Promise.resolve(['127.0.0.1']),
            isPublic: () => false,
            isAllowed: () => Promise.resolve(true),
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('intranet.test', 80));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
        expect(logs)
            .toHaveLength(1);
    });

    it('answers reply 4 when a name lookup takes longer than the timeout', async () => {
        const { gate } = await startGate({
            resolve: () => new Promise<string[]>(() => undefined),
            resolveTimeoutMs: 50,
        });
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('slow.test', 80));

        expect(replyCode)
            .toBe(REPLY_HOST_UNREACHABLE);
        socket.destroy();
    });

    it('connects nothing for a client that left while its name was being resolved', async () => {
        const echo = await startEchoServer();
        const { gate } = await startGate({
            resolve: () => new Promise<string[]>((resolve) => {
                setTimeout(() => {
                    resolve(['127.0.0.1']);
                }, 100);
            }),
            isPublic: () => true,
        });
        const socket = connect({ host: '127.0.0.1', port: gate.listeningPort });

        await once(socket, 'connect');
        socket.write(GREETING);
        await readBytes(socket, 2);
        socket.write(domainRequest('late.test', echo.port));
        await new Promise(resolve => setTimeout(resolve, 20));
        socket.destroy();
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(echo.connections())
            .toBe(0);
    });

    it('logs at most one refusal per host and port in a minute', async () => {
        const { gate, logs } = await startGate({
            resolve: () => Promise.resolve(['10.0.0.5']),
            isPublic: () => false,
        });
        const first = await sendRequest(gate.listeningPort, domainRequest('intranet.test', 80));
        const second = await sendRequest(gate.listeningPort, domainRequest('intranet.test', 80));
        const third = await sendRequest(gate.listeningPort, domainRequest('intranet.test', 81));

        [first, second, third].forEach(({ socket }) => {
            socket.destroy();
        });

        expect(logs)
            .toHaveLength(2);
    });

    it('caps the refusal log at 60 lines in a minute across all hosts, then lets lines through again', () => {
        let currentTime = 0;
        const shouldLog = createRefusalThrottle(() => currentTime);
        const keys = Array.from({ length: 61 }, (_unused, index) => `host-${String(index)}.test:80`);
        const firstMinute = keys.map(key => shouldLog(key));

        expect(firstMinute.filter(Boolean))
            .toHaveLength(60);
        expect(firstMinute.at(-1))
            .toBe(false);

        currentTime = 60_000;

        expect(shouldLog('host-60.test:80'))
            .toBe(true);
    });

    it('logs a server error after start and keeps accepting clients', async () => {
        const { gate, logs } = await startGate();

        (gate as unknown as GateWithServer).server?.emit('error', new Error('simulated failure'));

        expect(logs)
            .toContain('Browser gate error: simulated failure');

        const { replyCode, socket } = await sendRequest(gate.listeningPort, ipv4Request('127.0.0.1', 80));

        expect(replyCode)
            .toBe(REPLY_NOT_ALLOWED);
        socket.destroy();
    });

    it('closes a client over the socket cap at once', async () => {
        const { gate } = await startGate({ maxClientSockets: 2 });
        const clients = Array.from({ length: 2 }, () => connect({ host: '127.0.0.1', port: gate.listeningPort }));

        clients.forEach((client) => {
            client.on('error', () => undefined);
        });
        await Promise.all(clients.map(client => once(client, 'connect')));
        // The gate counts a client when it accepts it, which can come after the client sees the connect.
        await new Promise(resolve => setTimeout(resolve, 50));

        const extra = connect({ host: '127.0.0.1', port: gate.listeningPort });

        extra.on('error', () => undefined);

        const extraClosed = waitForClose(extra);

        await extraClosed;
        clients.forEach((client) => {
            client.destroy();
        });
    });

    it('answers reply 7 to a command other than CONNECT', async () => {
        const { gate } = await startGate();
        const { replyCode, socket } = await sendRequest(gate.listeningPort, domainRequest('public.test', 80, BIND_COMMAND));

        expect(replyCode)
            .toBe(REPLY_COMMAND_NOT_SUPPORTED);
        socket.destroy();
    });

    it('answers reply 8 to an unknown address type', async () => {
        const { gate } = await startGate();
        const badRequest = Buffer.from([5, CONNECT_COMMAND, 0, 9, 1, 2, 3, 4, 0, 80]);
        const { replyCode, socket } = await sendRequest(gate.listeningPort, badRequest);

        expect(replyCode)
            .toBe(REPLY_ADDRESS_NOT_SUPPORTED);
        socket.destroy();
    });

    it('closes a connection whose greeting is not SOCKS5', async () => {
        const { gate } = await startGate();
        const socket = connect({ host: '127.0.0.1', port: gate.listeningPort });
        const closed = waitForClose(socket);

        await once(socket, 'connect');
        socket.write(Buffer.from([4, 1, 0]));
        await closed;
    });

    it('closes a client that sends too many bytes before the tunnel opens', async () => {
        const { gate } = await startGate({
            resolve: () => new Promise<string[]>(() => undefined),
        });
        const socket = connect({ host: '127.0.0.1', port: gate.listeningPort });
        const closed = waitForClose(socket);
        const flood = Buffer.alloc(100 * 1024, 65);

        await once(socket, 'connect');
        socket.write(GREETING);
        await readBytes(socket, 2);
        socket.write(Buffer.concat([domainRequest('slow.test', 80), flood]));
        await closed;
    });
});
