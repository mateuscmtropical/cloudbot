import { describe, expect, it, vi } from 'vitest';

import { DiscordApiError, MAX_MESSAGE_CHARACTERS, createDiscordApi, readDirectMessage, splitMessage } from './DiscordApi.ts';
import type { DiscordMessage, DiscordSocket } from './DiscordApi.ts';

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket implements DiscordSocket {
    readonly sent: Record<string, unknown>[] = [];
    isClosed = false;
    private readonly listeners = new Map<string, Listener>();

    addEventListener(type: string, listener: Listener): void {
        this.listeners.set(type, listener);
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }

    closeCode: number | undefined;

    close(code?: number): void {
        this.isClosed = true;
        this.closeCode = code;
    }

    receive(payload: Record<string, unknown>): void {
        this.listeners.get('message')?.({ data: JSON.stringify(payload) });
    }

    closeWith(code: number): void {
        this.listeners.get('close')?.({ code });
    }
}

const TOKEN = 'secret-token';

function directMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { op: 0, t: 'MESSAGE_CREATE', s: 3, d: { channel_id: '55', content: 'hi', author: { id: '7' }, ...overrides } };
}

describe('splitMessage', () => {
    it('cuts a long reply into parts Discord accepts', () => {
        const parts = splitMessage('a'.repeat(MAX_MESSAGE_CHARACTERS + 1));

        expect(parts.map(part => part.length))
            .toEqual([MAX_MESSAGE_CHARACTERS, 1]);
    });
});

describe('readDirectMessage', () => {
    it('reads a direct message', () => {
        expect(readDirectMessage({ channel_id: '55', content: 'hi', author: { id: '7' } }))
            .toEqual({ authorId: '7', channelId: '55', text: 'hi' });
    });

    it('drops server messages and bots', () => {
        expect(readDirectMessage({ guild_id: '1', channel_id: '55', content: 'hi', author: { id: '7' } }))
            .toBeUndefined();
        expect(readDirectMessage({ channel_id: '55', content: 'hi', author: { id: '7', bot: true } }))
            .toBeUndefined();
    });
});

describe('createDiscordApi listen', () => {
    function start(): { socket: FakeSocket; messages: DiscordMessage[]; controller: AbortController; ended: Promise<void> } {
        const socket = new FakeSocket();
        const messages: DiscordMessage[] = [];
        const controller = new AbortController();
        const api = createDiscordApi(TOKEN, vi.fn(), () => socket);
        const ended = api.listen((message) => {
            messages.push(message);

            return Promise.resolve();
        }, controller.signal);

        return { socket, messages, controller, ended };
    }

    it('identifies for direct messages only and passes direct messages on', async () => {
        const { socket, messages, controller, ended } = start();

        socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
        expect(socket.sent[0])
            .toMatchObject({ op: 2, d: { token: TOKEN, intents: 1 << 12 } });
        socket.receive(directMessage());
        socket.receive(directMessage({ guild_id: '9' }));
        expect(messages)
            .toEqual([{ authorId: '7', channelId: '55', text: 'hi' }]);
        controller.abort();
        await expect(ended).resolves.toBeUndefined();
        expect(socket.isClosed)
            .toBe(true);
    });

    it('answers a heartbeat request with the last sequence', () => {
        const { socket, controller } = start();

        socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
        socket.receive(directMessage());
        socket.receive({ op: 1 });
        expect(socket.sent.at(-1))
            .toEqual({ op: 1, d: 3 });
        controller.abort();
    });

    it('fails when Discord asks to connect again', async () => {
        const { socket, ended } = start();

        socket.receive({ op: 7, d: null });
        await expect(ended).rejects.toMatchObject({ isFatal: false });
    });

    it('marks a rejected token as fatal without naming it', async () => {
        const { socket, ended } = start();

        socket.closeWith(4004);
        const error: unknown = await ended.catch((caught: unknown) => caught);

        expect(error)
            .toBeInstanceOf(DiscordApiError);
        expect(error)
            .toMatchObject({ isFatal: true });
        expect((error as Error).message)
            .not.toContain(TOKEN);
    });

    it('fails when the heartbeat is never acknowledged', async () => {
        vi.useFakeTimers();

        try {
            const { socket, ended } = start();
            const failure = ended.catch((caught: unknown) => caught);

            socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
            await vi.advanceTimersByTimeAsync(2500);
            await expect(failure).resolves.toBeInstanceOf(DiscordApiError);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('createDiscordApi resume', () => {
    const RESUME_URL = 'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json';

    // One api, a new fake socket for each listen call.
    function setup(): { sockets: FakeSocket[]; urls: string[]; messages: DiscordMessage[]; connect: () => { socket: FakeSocket; ended: Promise<unknown> } } {
        const sockets: FakeSocket[] = [];
        const urls: string[] = [];
        const messages: DiscordMessage[] = [];
        const api = createDiscordApi(TOKEN, vi.fn(), (url) => {
            const socket = new FakeSocket();

            urls.push(url);
            sockets.push(socket);

            return socket;
        });
        const connect = (): { socket: FakeSocket; ended: Promise<unknown> } => {
            const ended = api.listen((message) => {
                messages.push(message);

                return Promise.resolve();
            }, new AbortController().signal)
                .catch((caught: unknown) => caught);
            const socket = sockets.at(-1) as FakeSocket;

            socket.receive({ op: 10, d: { heartbeat_interval: 60_000 } });

            return { socket, ended };
        };

        return { sockets, urls, messages, connect };
    }

    function ready(socket: FakeSocket, resumeUrl = 'wss://gateway-us-east1-b.discord.gg'): void {
        socket.receive({ op: 0, t: 'READY', s: 1, d: { session_id: 'abc', resume_gateway_url: resumeUrl } });
    }

    it('resumes the session on the resume address after a lost connection', async () => {
        const { urls, connect } = setup();
        const first = connect();

        ready(first.socket);
        first.socket.receive(directMessage({ id: 'm1' }));
        first.socket.closeWith(1006);
        await first.ended;
        expect(first.socket.closeCode)
            .toBe(4000);

        const second = connect();

        expect(urls)
            .toEqual(['wss://gateway.discord.gg/?v=10&encoding=json', RESUME_URL]);
        expect(second.socket.sent[0])
            .toEqual({ op: 6, d: { token: TOKEN, session_id: 'abc', seq: 3 } });
    });

    it('resumes after Discord asks to reconnect', async () => {
        const { connect } = setup();
        const first = connect();

        ready(first.socket);
        first.socket.receive({ op: 7, d: null });
        await first.ended;

        expect(connect().socket.sent[0])
            .toMatchObject({ op: 6 });
    });

    it('never hands over a message twice when Discord replays it', async () => {
        const { messages, connect } = setup();
        const first = connect();

        ready(first.socket);
        first.socket.receive(directMessage({ id: 'm1' }));
        first.socket.closeWith(1006);
        await first.ended;

        const second = connect();

        second.socket.receive(directMessage({ id: 'm1' }));
        second.socket.receive(directMessage({ id: 'm2' }));
        expect(messages.length)
            .toBe(2);
    });

    it('resumes after a resumable invalid session and identifies after a lost one', async () => {
        const { urls, connect } = setup();
        const first = connect();

        ready(first.socket);
        first.socket.receive({ op: 9, d: true });
        await first.ended;

        const second = connect();

        expect(second.socket.sent[0])
            .toMatchObject({ op: 6 });
        second.socket.receive({ op: 9, d: false });
        await second.ended;

        const third = connect();

        expect(urls[2])
            .toBe('wss://gateway.discord.gg/?v=10&encoding=json');
        expect(third.socket.sent[0])
            .toMatchObject({ op: 2 });
    });

    it('identifies again after the session timed out', async () => {
        const { connect } = setup();
        const first = connect();

        ready(first.socket);
        first.socket.closeWith(4009);
        await first.ended;

        expect(connect().socket.sent[0])
            .toMatchObject({ op: 2 });
    });

    it('does not send the token to a resume address outside Discord', async () => {
        const { connect } = setup();
        const first = connect();

        ready(first.socket, 'wss://evil.example.com');
        first.socket.closeWith(1006);
        await first.ended;

        expect(connect().socket.sent[0])
            .toMatchObject({ op: 2 });
    });
});

describe('createDiscordApi sendMessage', () => {
    it('posts each part to the channel with the bot token', async () => {
        const calls: { url: string; init: RequestInit }[] = [];
        const fetchFunction = (url: string, init: RequestInit): Promise<Response> => {
            calls.push({ url, init });

            return Promise.resolve(new Response('{}', { status: 200 }));
        };
        const api = createDiscordApi(TOKEN, fetchFunction);

        await api.sendMessage('55', 'a'.repeat(MAX_MESSAGE_CHARACTERS + 5));
        expect(calls.map(call => call.url))
            .toEqual(['https://discord.com/api/v10/channels/55/messages', 'https://discord.com/api/v10/channels/55/messages']);
        expect(calls[0]?.init.headers)
            .toMatchObject({ authorization: `Bot ${TOKEN}` });
    });

    it('fails without the token when Discord refuses', async () => {
        const api = createDiscordApi(TOKEN, () => Promise.resolve(new Response('{}', { status: 429 })));
        const error: unknown = await api.sendMessage('55', 'hi')
            .catch((caught: unknown) => caught);

        expect((error as Error).message)
            .toContain('429');
        expect((error as Error).message)
            .not.toContain(TOKEN);
    });
});
