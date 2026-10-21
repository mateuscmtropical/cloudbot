// One DevTools protocol connection to one page of the bot's Chromium.
// Node's built-in WebSocket is enough, so there is no browser library.

interface CdpResponse {
    id?: number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { message?: string };
}

interface PendingCall {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface CdpSocket {
    readyState: number;
    addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
    send(data: string): void;
    close(): void;
}

type CdpSocketFactory = (url: string) => CdpSocket;

type CdpEventListener = (method: string, params: unknown) => void;

const CALL_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 5_000;
const SOCKET_OPEN = 1;

class CdpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CdpError';
    }
}

function createWebSocket(url: string): CdpSocket {
    return new WebSocket(url);
}

class CdpConnection {
    private readonly socket: CdpSocket;
    private readonly pending = new Map<number, PendingCall>();
    private eventListener: CdpEventListener | undefined;
    private nextId = 1;

    private constructor(socket: CdpSocket) {
        this.socket = socket;
        socket.addEventListener('message', (event) => {
            this.handleMessage(event.data);
        });
        socket.addEventListener('close', () => {
            this.failAll('The browser connection closed.');
        });
    }

    static async open(url: string, socketFactory: CdpSocketFactory = createWebSocket, timeoutMs = OPEN_TIMEOUT_MS): Promise<CdpConnection> {
        const socket = socketFactory(url);
        let timer: NodeJS.Timeout | undefined;

        try {
            await new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => {
                    socket.close();
                    reject(new CdpError('The browser did not accept the connection in time.'));
                }, timeoutMs);
                socket.addEventListener('open', () => {
                    resolve();
                }, { once: true });
                socket.addEventListener('error', () => {
                    reject(new CdpError('Could not connect to the browser.'));
                }, { once: true });
            });
        } finally {
            clearTimeout(timer);
        }

        return new CdpConnection(socket);
    }

    // One listener for the events of the page, such as a dialog that opens.
    onEvent(listener: CdpEventListener): void {
        this.eventListener = listener;
    }

    call(method: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
        if (this.socket.readyState !== SOCKET_OPEN) {
            return Promise.reject(new CdpError('The browser connection is closed.'));
        }

        const id = this.nextId;

        this.nextId += 1;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpError(`The browser did not answer ${method} in time.`));
            }, timeoutMs);

            const message = JSON.stringify({ id, method, params });

            this.pending.set(id, { resolve, reject, timer });
            this.socket.send(message);
        });
    }

    close(): void {
        this.failAll('The browser connection closed.');
        this.socket.close();
    }

    private handleMessage(data: unknown): void {
        if (typeof data !== 'string') {
            return;
        }

        let response: CdpResponse;

        try {
            response = JSON.parse(data) as CdpResponse;
        } catch {
            // Chromium sends only JSON. Anything else is ignored rather than ending the call.
            return;
        }

        // Events have a method and no id.
        if (response.id === undefined) {
            if (typeof response.method === 'string') {
                this.eventListener?.(response.method, response.params);
            }

            return;
        }

        const pendingCall = this.pending.get(response.id);

        if (pendingCall === undefined) {
            return;
        }

        this.pending.delete(response.id);
        clearTimeout(pendingCall.timer);

        if (response.error !== undefined) {
            pendingCall.reject(new CdpError(response.error.message ?? 'The browser refused the command.'));

            return;
        }

        pendingCall.resolve(response.result);
    }

    private failAll(message: string): void {
        this.pending.forEach((pendingCall) => {
            clearTimeout(pendingCall.timer);
            pendingCall.reject(new CdpError(message));
        });
        this.pending.clear();
    }
}

export { CdpConnection, CdpError };
export type { CdpEventListener, CdpSocket, CdpSocketFactory };
