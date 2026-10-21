import { createServer, connect as connectSocket, isIP } from 'node:net';
import type { Server, Socket } from 'node:net';
import { lookup } from 'node:dns/promises';

import { isAllowablePrivateAddress, isPublicAddress, readLocalAddresses } from '../watches/publicAddress.ts';
import { normalizeHost } from './browserHost.ts';

// The browser's proxy. docker/cloudbot-desktop starts Chromium with this port, so the two must match.
const BROWSER_GATE_PORT = 9224;
const GATE_HOST = '127.0.0.1';

// SOCKS5 as in RFC 1928. Only CONNECT with no authentication is spoken.
const SOCKS_VERSION = 5;
const METHOD_NO_AUTH = 0;
const METHOD_NONE_ACCEPTED = 0xFF;
const COMMAND_CONNECT = 1;
const ATYP_IPV4 = 1;
const ATYP_DOMAIN = 3;
const ATYP_IPV6 = 4;
const REPLY_SUCCEEDED = 0;
const REPLY_CONNECTION_REFUSED = 5;
const REPLY_HOST_UNREACHABLE = 4;
const REPLY_NOT_ALLOWED = 2;
const REPLY_COMMAND_NOT_SUPPORTED = 7;
const REPLY_ADDRESS_NOT_SUPPORTED = 8;
const REQUEST_MIN_LENGTH = 5;

// Bytes held before the tunnel opens. A client may send data right after its request, so this caps that data.
const MAX_PENDING_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1'];
// Open client sockets the gate keeps. A client past this count is closed at once.
const MAX_CLIENT_SOCKETS = 256;
const DEFAULT_RESOLVE_TIMEOUT_MS = 5_000;
// At most one refusal line per host and port in this period, so a retrying page cannot fill the log.
const REFUSAL_LOG_INTERVAL_MS = 60_000;
const MAX_REFUSAL_KEYS = 1000;
// Across all hosts, at most this many refusal lines in one interval. Later refusals in the interval are dropped.
const MAX_REFUSAL_LINES_PER_INTERVAL = 60;

interface GateDependencies {
    // Returns every address of a name. It throws when the name cannot be resolved.
    resolve: (name: string) => Promise<string[]>;
    // Gives up on a name lookup after this many milliseconds, so a slow name server cannot hold a client.
    resolveTimeoutMs: number;
    // True when an address may be reached without the owner allowing its host.
    isPublic: (address: string) => boolean;
    // True for a private address that the owner may allow, such as 10.x or 192.168.x. Loopback is never one.
    isAllowablePrivate: (address: string) => boolean;
    // True when the owner allowed this host (normalized) on this port.
    isAllowed: (host: string, port: number) => Promise<boolean>;
    // True when a refusal for this key (host and port) may be logged now.
    shouldLogRefusal: (key: string) => boolean;
    log: (line: string) => void;
}

interface BrowserGateOptions extends Partial<GateDependencies> {
    // Tests pass 0 to get a free port.
    port?: number;
    // Open client sockets the gate keeps. Tests pass a small number.
    maxClientSockets?: number;
}

interface ParsedGreeting {
    acceptsNoAuth: boolean;
}

interface ParsedRequest {
    command: number;
    host: string;
    port: number;
}

interface ParseComplete<T> {
    status: 'complete';
    value: T;
    length: number;
}

interface ParseFailure {
    status: 'incomplete' | 'invalid' | 'unsupported';
}

type ParseResult<T> = ParseComplete<T> | ParseFailure;

type SessionPhase = 'greeting' | 'request' | 'connecting' | 'tunnel' | 'closed';

function parseGreeting(buffer: Buffer): ParseResult<ParsedGreeting> {
    if (buffer.length < 2) {
        return { status: 'incomplete' };
    }

    if (buffer[0] !== SOCKS_VERSION) {
        return { status: 'invalid' };
    }

    const methodCount = buffer[1] ?? 0;
    const length = 2 + methodCount;

    if (buffer.length < length) {
        return { status: 'incomplete' };
    }

    const methods = [...buffer.subarray(2, length)];

    return { status: 'complete', value: { acceptsNoAuth: methods.includes(METHOD_NO_AUTH) }, length };
}

// The address and port of a request. A domain name is kept as text, and an IPv6 address is written in full hex groups.
function parseRequest(buffer: Buffer): ParseResult<ParsedRequest> {
    if (buffer.length < REQUEST_MIN_LENGTH) {
        return { status: 'incomplete' };
    }

    if (buffer[0] !== SOCKS_VERSION) {
        return { status: 'invalid' };
    }

    const command = buffer[1] ?? 0;
    const addressType = buffer[3] ?? 0;
    const domainLength = buffer[4] ?? 0;
    const isDomain = addressType === ATYP_DOMAIN;
    const addressStart = isDomain ? 5 : 4;
    let addressSize: number;

    if (addressType === ATYP_IPV4) {
        addressSize = 4;
    } else if (addressType === ATYP_IPV6) {
        addressSize = 16;
    } else if (isDomain) {
        addressSize = domainLength;
    } else {
        return { status: 'unsupported' };
    }

    const portStart = addressStart + addressSize;
    const length = portStart + 2;

    if (buffer.length < length) {
        return { status: 'incomplete' };
    }

    const addressBytes = buffer.subarray(addressStart, portStart);
    const host = readHost(addressType, addressBytes);
    const port = buffer.readUInt16BE(portStart);

    return { status: 'complete', value: { command, host, port }, length };
}

function readHost(addressType: number, addressBytes: Buffer): string {
    if (addressType === ATYP_IPV4) {
        return [...addressBytes].join('.');
    }

    if (addressType === ATYP_IPV6) {
        return Array.from({ length: 8 }, (_unused, index) => addressBytes.readUInt16BE(index * 2)
            .toString(16))
            .join(':');
    }

    return addressBytes.toString('utf8');
}

// The ten byte reply of RFC 1928. Its address and port are zero, which the client does not use.
function buildReply(code: number): Buffer {
    return Buffer.from([SOCKS_VERSION, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

// Opens a connection to exactly this address, so no second DNS answer can change where the bytes go.
function connectTo(address: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connectSocket({ host: address, port });

        socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
            const timeoutError = new Error('The connection timed out.');

            socket.destroy(timeoutError);
        });
        socket.once('connect', () => {
            socket.setTimeout(0);
            resolve(socket);
        });
        socket.once('error', reject);
    });
}

async function connectFirst(addresses: string[], port: number): Promise<Socket> {
    const [address, ...rest] = addresses;

    if (address === undefined) {
        throw new Error('No address could be connected.');
    }

    try {
        return await connectTo(address, port);
    } catch {
        return connectFirst(rest, port);
    }
}

// Rejects when the promise does not settle in time, so a slow lookup cannot hold a client.
function withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error('The name lookup timed out.'));
        }, timeoutMs);
    });

    return Promise.race([pending, timeout])
        .finally(() => {
            clearTimeout(timer);
        });
}

// Lets one refusal per key through each interval, and at most MAX_REFUSAL_LINES_PER_INTERVAL in all. The keys are
// cleared when there are too many of them.
function createRefusalThrottle(now: () => number): (key: string) => boolean {
    const lastLogged = new Map<string, number>();
    let intervalStart = now();
    let linesInInterval = 0;

    return (key: string): boolean => {
        const current = now();

        if (current - intervalStart >= REFUSAL_LOG_INTERVAL_MS) {
            intervalStart = current;
            linesInInterval = 0;
        }

        const last = lastLogged.get(key);

        if (last !== undefined && current - last < REFUSAL_LOG_INTERVAL_MS) {
            return false;
        }

        if (linesInInterval >= MAX_REFUSAL_LINES_PER_INTERVAL) {
            return false;
        }

        if (lastLogged.size >= MAX_REFUSAL_KEYS) {
            lastLogged.clear();
        }

        lastLogged.set(key, current);
        linesInInterval += 1;

        return true;
    };
}

// One client of the gate. It runs the handshake, checks the address, then pipes the bytes both ways.
class GateSession {
    private readonly socket: Socket;
    private readonly dependencies: GateDependencies;
    private buffer: Buffer = Buffer.alloc(0);
    private phase: SessionPhase = 'greeting';

    constructor(socket: Socket, dependencies: GateDependencies) {
        this.socket = socket;
        this.dependencies = dependencies;
    }

    start(): void {
        this.socket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
            this.socket.destroy();
        });
        this.socket.on('data', (chunk: Buffer) => {
            this.receive(chunk);
        });
        this.socket.on('error', () => {
            this.socket.destroy();
        });
        // A client that leaves before the tunnel opens ends the session, so nothing is connected for it.
        this.socket.on('close', () => {
            if (this.phase !== 'tunnel') {
                this.phase = 'closed';
            }
        });
    }

    private receive(chunk: Buffer): void {
        if (this.phase === 'tunnel' || this.phase === 'closed') {
            return;
        }

        this.buffer = Buffer.concat([this.buffer, chunk]);

        if (this.buffer.length > MAX_PENDING_BYTES) {
            this.socket.destroy();

            return;
        }

        if (this.phase === 'greeting') {
            this.readGreeting();
        }

        if (this.phase === 'request') {
            this.readRequest();
        }
    }

    private readGreeting(): void {
        const greeting = parseGreeting(this.buffer);

        if (greeting.status === 'incomplete') {
            return;
        }

        if (greeting.status !== 'complete') {
            this.socket.destroy();

            return;
        }

        this.buffer = this.buffer.subarray(greeting.length);

        if (!greeting.value.acceptsNoAuth) {
            this.finish(METHOD_NONE_ACCEPTED);

            return;
        }

        const methodReply = Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]);

        this.socket.write(methodReply);
        this.phase = 'request';
    }

    private readRequest(): void {
        const request = parseRequest(this.buffer);

        if (request.status === 'incomplete') {
            return;
        }

        if (request.status !== 'complete') {
            const replyCode = request.status === 'unsupported' ? REPLY_ADDRESS_NOT_SUPPORTED : undefined;

            if (replyCode === undefined) {
                this.socket.destroy();
            } else {
                this.finishWithReply(replyCode);
            }

            return;
        }

        this.buffer = this.buffer.subarray(request.length);

        if (request.value.command !== COMMAND_CONNECT) {
            this.finishWithReply(REPLY_COMMAND_NOT_SUPPORTED);

            return;
        }

        this.phase = 'connecting';
        this.openTunnel(request.value)
            .catch(() => {
                this.socket.destroy();
            });
    }

    private async openTunnel(request: ParsedRequest): Promise<void> {
        const host = normalizeHost(request.host);

        if (host === undefined) {
            this.finishWithReply(REPLY_HOST_UNREACHABLE);

            return;
        }

        const isAllowed = await this.dependencies.isAllowed(host, request.port);
        const addresses = await this.resolveAddresses(host);

        if (!this.isStillConnecting()) {
            return;
        }

        if (addresses.length === 0) {
            this.finishWithReply(REPLY_HOST_UNREACHABLE);

            return;
        }

        // Every address is checked, also for an allowed host. An allowed host passes only with private, allowable addresses.
        const everyAddressIsAllowed = addresses.every(address => this.dependencies.isPublic(address) || (isAllowed && this.dependencies.isAllowablePrivate(address)));

        if (!everyAddressIsAllowed) {
            const refusalKey = `${host}:${String(request.port)}`;

            if (this.dependencies.shouldLogRefusal(refusalKey)) {
                const timestamp = new Date()
                    .toISOString();

                this.dependencies.log(`${timestamp} Browser gate refused ${refusalKey}, a private or forbidden address.`);
            }

            this.finishWithReply(REPLY_NOT_ALLOWED);

            return;
        }

        const target = await connectFirst(addresses, request.port)
            .catch(() => undefined);

        if (target === undefined || !this.isStillConnecting()) {
            target?.destroy();
            this.finishWithReply(REPLY_CONNECTION_REFUSED);

            return;
        }

        this.startTunnel(target);
    }

    // A literal address is used as it is. The name list is only read when the name is not a literal.
    private async resolveAddresses(host: string): Promise<string[]> {
        if (isIP(host) !== 0) {
            return [host];
        }

        if (host === 'localhost' || host.endsWith('.localhost')) {
            return LOOPBACK_ADDRESSES;
        }

        const lookup = this.dependencies.resolve(host);

        try {
            return await withTimeout(lookup, this.dependencies.resolveTimeoutMs);
        } catch {
            return [];
        }
    }

    private startTunnel(target: Socket): void {
        const successReply = buildReply(REPLY_SUCCEEDED);

        this.phase = 'tunnel';
        this.socket.setTimeout(0);
        this.socket.write(successReply);

        const pending = this.buffer;

        this.buffer = Buffer.alloc(0);
        this.socket.removeAllListeners('data');
        target.on('error', () => {
            this.socket.destroy();
        });
        this.socket.on('close', () => {
            target.destroy();
        });
        target.on('close', () => {
            this.socket.destroy();
        });

        if (pending.length > 0) {
            target.write(pending);
        }

        this.socket.pipe(target);
        target.pipe(this.socket);
    }

    private finishWithReply(code: number): void {
        const reply = buildReply(code);

        this.phase = 'closed';
        this.socket.end(reply);
    }

    // A method, so the check reads the phase again after each await.
    private isStillConnecting(): boolean {
        return this.phase === 'connecting';
    }

    private finish(method: number): void {
        const methodReply = Buffer.from([SOCKS_VERSION, method]);

        this.phase = 'closed';
        this.socket.end(methodReply);
    }
}

// A SOCKS5 proxy on localhost. It connects only to public addresses, or to hosts the owner allowed.
// It checks the address it connects to, so a name that changes its answer cannot pass.
class BrowserGate {
    private readonly port: number;
    private readonly maxClientSockets: number;
    private readonly dependencies: GateDependencies;
    private readonly sockets = new Set<Socket>();
    private server: Server | undefined;

    constructor(options: BrowserGateOptions = {}) {
        this.port = options.port ?? BROWSER_GATE_PORT;
        this.maxClientSockets = options.maxClientSockets ?? MAX_CLIENT_SOCKETS;
        this.dependencies = {
            resolve: options.resolve ?? resolveWithSystem,
            resolveTimeoutMs: options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS,
            isPublic: options.isPublic ?? isPublicNow,
            isAllowablePrivate: options.isAllowablePrivate ?? isAllowablePrivateNow,
            isAllowed: options.isAllowed ?? (() => Promise.resolve(false)),
            shouldLogRefusal: options.shouldLogRefusal ?? createRefusalThrottle(() => Date.now()),
            log: options.log ?? ((line) => { console.log(line); }),
        };
    }

    // The port the gate listens on. It is the real port once the gate has started.
    get listeningPort(): number {
        const address = this.server?.address();

        return typeof address === 'object' && address !== null ? address.port : 0;
    }

    async start(): Promise<void> {
        const server = createServer((socket) => {
            this.accept(socket);
        });

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(this.port, GATE_HOST, () => {
                server.off('error', reject);
                resolve();
            });
        });

        // After start, an error is logged and the gate keeps running.
        server.on('error', (error: Error) => {
            this.dependencies.log(`Browser gate error: ${error.message}`);
        });
        this.server = server;
    }

    async close(): Promise<void> {
        const server = this.server;

        this.server = undefined;
        this.sockets.forEach((socket) => {
            socket.destroy();
        });

        if (server === undefined) {
            return;
        }

        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    }

    private accept(socket: Socket): void {
        if (this.sockets.size >= this.maxClientSockets) {
            socket.destroy();

            return;
        }

        this.sockets.add(socket);
        socket.on('close', () => {
            this.sockets.delete(socket);
        });

        const session = new GateSession(socket, this.dependencies);

        session.start();
    }
}

// The machine's own addresses are read at each check, so an address added while the server runs is seen.
function isPublicNow(address: string): boolean {
    const localAddresses = readLocalAddresses();

    return isPublicAddress(address, localAddresses);
}

function isAllowablePrivateNow(address: string): boolean {
    const localAddresses = readLocalAddresses();

    return isAllowablePrivateAddress(address, localAddresses);
}

async function resolveWithSystem(name: string): Promise<string[]> {
    const entries = await lookup(name, { all: true });

    return entries.map(entry => entry.address);
}

export { BROWSER_GATE_PORT, BrowserGate, createRefusalThrottle, parseGreeting, parseRequest };
export type { BrowserGateOptions, GateDependencies };
