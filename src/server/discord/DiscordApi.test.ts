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

    close(): void {
        this.isClosed = true;
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
