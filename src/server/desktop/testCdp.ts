import type { CdpSocket, CdpSocketFactory } from './CdpConnection.ts';

interface SentCall {
    id: number;
    method: string;
    params: Record<string, unknown>;
}

type CdpAnswer = (call: SentCall) => { result?: unknown; error?: { message: string } } | undefined;

type SocketListener = (event: { data?: unknown }) => void;

// A fake Chromium page socket. It answers each call with the answer function, or never when it returns undefined.
class FakeCdpSocket implements CdpSocket {
    readyState = 0;
    readonly sent: SentCall[] = [];
    isClosed = false;
    private readonly listeners = new Map<string, SocketListener[]>();
    private readonly answer: CdpAnswer;

    constructor(answer: CdpAnswer) {
        this.answer = answer;
    }

    addEventListener(type: string, listener: SocketListener): void {
        const existing = this.listeners.get(type) ?? [];

        this.listeners.set(type, [...existing, listener]);
    }

    send(data: string): void {
        const call = JSON.parse(data) as SentCall;
        const answered = this.answer(call);

        this.sent.push(call);

        if (answered !== undefined) {
            queueMicrotask(() => {
                this.emit('message', { data: JSON.stringify({ id: call.id, ...answered }) });
            });
        }
    }

    close(): void {
        this.isClosed = true;
        this.readyState = 3;
        this.emit('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }

    fail(): void {
        this.emit('error', {});
    }

    emit(type: string, event: { data?: unknown }): void {
        const listeners = this.listeners.get(type) ?? [];

        listeners.forEach((listener) => {
            listener(event);
        });
    }
}

interface FakeSocketFactory {
    factory: CdpSocketFactory;
    sockets: FakeCdpSocket[];
    urls: string[];
}

// Each socket opens on the next microtask, like a real connection that succeeds.
function createFakeSocketFactory(answer: CdpAnswer, shouldFail = false): FakeSocketFactory {
    const sockets: FakeCdpSocket[] = [];
    const urls: string[] = [];
    const factory: CdpSocketFactory = (url) => {
        const socket = new FakeCdpSocket(answer);

        sockets.push(socket);
        urls.push(url);
        queueMicrotask(() => {
            if (shouldFail) {
                socket.fail();

                return;
            }

            socket.open();
        });

        return socket;
    };

    return { factory, sockets, urls };
}

export { FakeCdpSocket, createFakeSocketFactory };
export type { CdpAnswer, SentCall };
