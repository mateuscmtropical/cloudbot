import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import type { TelegramApi, TelegramUpdate } from './TelegramApi.ts';
import { LINK_KEY_PREFIX, MAX_FAILED_TRIES, OFFSET_KEY_PREFIX, PAIRING_LIFETIME_MS, TelegramBridge } from './TelegramBridge.ts';
import type { TelegramSettings } from './TelegramBridge.ts';

const BOT_ID = 'bot-1';
const OWNER_ID = 42;
const OWNER_CHAT = 4200;

// A Telegram stand-in. Each poll takes the next batch, and with none left it waits until the poll is stopped.
class FakeTelegram {
    readonly batches: TelegramUpdate[][] = [];
    readonly sent: { chatId: number; text: string }[] = [];
    readonly offsets: number[] = [];
    failNextSend = false;
    private nextId = 1;
    private wake: (() => void) | undefined;

    readonly api: TelegramApi = {
        getUpdates: async (offset, _timeout, signal) => {
            this.offsets.push(offset);
            const batch = this.takeBatch(offset);

            if (batch !== undefined) {
                return batch;
            }

            await new Promise<void>((resolve) => {
                this.wake = resolve;
                signal.addEventListener('abort', () => {
                    resolve();
                }, { once: true });
            });

            // An aborted request takes nothing, as a real aborted fetch does.
            if (signal.aborted) {
                throw new Error('aborted');
            }

            return this.takeBatch(offset) ?? [];
        },
        sendMessage: (chatId, text) => {
            if (this.failNextSend) {
                this.failNextSend = false;

                return Promise.reject(new Error('Telegram refused sendMessage with status 429.'));
            }

            this.sent.push({ chatId, text });

            return Promise.resolve();
        },
    };

    receive(text: string | undefined, from: number = OWNER_ID, chat: { id: number; type: string } = { id: OWNER_CHAT, type: 'private' }): TelegramUpdate {
        const update: TelegramUpdate = { update_id: this.nextId, message: { chat, from: { id: from }, text } };

        this.nextId += 1;
        this.batches.push([update]);
        this.wake?.();

        return update;
    }

    replay(update: TelegramUpdate): void {
        this.batches.push([update]);
        this.wake?.();
    }

    // Telegram sends an update until a later poll asks from an offset above it.
    private takeBatch(offset: number): TelegramUpdate[] | undefined {
        const batch = this.batches.shift();

        if (batch === undefined) {
            return undefined;
        }

        const remaining = batch.filter(update => update.update_id >= offset);

        return remaining.length === 0 ? this.takeBatch(offset) : remaining;
    }
}

function makeSettings(): TelegramSettings & { values: Map<string, string> } {
    const values = new Map<string, string>();

    return {
        values,
        get: key => Promise.resolve(values.get(key)),
        set: (key, value) => {
            values.set(key, value);

            return Promise.resolve();
        },
        delete: (key) => {
            values.delete(key);

            return Promise.resolve();
        },
    };
}

function makeBridge(options: { token?: string | undefined; now?: () => number; settings?: ReturnType<typeof makeSettings> } = {}): {
    bridge: TelegramBridge;
    telegram: FakeTelegram;
    settings: ReturnType<typeof makeSettings>;
    notices: string[];
    sentToBot: string[];
    emit: (event: ChatEvent) => void;
} {
    const telegram = new FakeTelegram();
    const settings = options.settings ?? makeSettings();
    const notices: string[] = [];
    const sentToBot: string[] = [];
    const listeners: ((event: ChatEvent) => void)[] = [];
    const token = 'token' in options ? options.token : '1:fake';
    const bridge = new TelegramBridge({
        chat: {
            sendMessage: (_botId, text) => {
                sentToBot.push(text);

                return Promise.resolve();
            },
            subscribe: (_botId, listener) => {
                listeners.push(listener);

                return () => {
                    listeners.splice(listeners.indexOf(listener), 1);
                };
            },
            postNotice: (_botId, text) => {
                notices.push(text);

                return Promise.resolve();
            },
        },
        settings,
        readToken: () => token,
        createApi: () => telegram.api,
        retryDelayMs: 1,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    const emit = (event: ChatEvent): void => {
        [...listeners].forEach((listener) => {
            listener(event);
        });
    };

    return { bridge, telegram, settings, notices, sentToBot, emit };
}

function codeFrom(notices: string[]): string {
    const match = /Telegram code: (\S+)/.exec(notices[0] ?? '');

    return match?.[1] ?? '';
}

function assistantText(text: string): ChatEvent {
    return { type: 'message', message: { id: 'm1', botId: BOT_ID, role: 'assistant', createdAt: 1, sequence: 1, body: { kind: 'text', text } } };
}

const bridges: TelegramBridge[] = [];

afterEach(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    bridges.length = 0;
});

async function pair(setup: ReturnType<typeof makeBridge>): Promise<void> {
    bridges.push(setup.bridge);
    await setup.bridge.startPairing(BOT_ID);
    setup.telegram.receive(`/start ${codeFrom(setup.notices)}`);
    await vi.waitFor(() => {
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(true);
    });
}

describe('TelegramBridge', () => {
    it('refuses to pair without a saved token', async () => {
        const setup = makeBridge({ token: undefined });

        await expect(setup.bridge.startPairing(BOT_ID)).resolves.toBe(false);
        expect(setup.notices)
            .toEqual([]);
    });

    it('pairs the account that sends the code and saves the link', async () => {
        const setup = makeBridge();

        await pair(setup);

        expect(setup.settings.values.get(`${LINK_KEY_PREFIX}${BOT_ID}`))
            .toBe(JSON.stringify({ userId: OWNER_ID, chatId: OWNER_CHAT }));
        expect(setup.telegram.sent[0]?.chatId)
            .toBe(OWNER_CHAT);
        expect(setup.notices[1])
            .toContain('Telegram is connected');
    });

    it('ignores a code sent from a group chat', async () => {
        const setup = makeBridge();

        bridges.push(setup.bridge);
        await setup.bridge.startPairing(BOT_ID);
        setup.telegram.receive(`/start ${codeFrom(setup.notices)}`, OWNER_ID, { id: -1, type: 'group' });
        setup.telegram.receive('/start WRONG');
        await vi.waitFor(() => {
            expect(setup.telegram.batches)
                .toHaveLength(0);
        });
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('ends the pairing after too many wrong codes', async () => {
        const setup = makeBridge();

        bridges.push(setup.bridge);
        await setup.bridge.startPairing(BOT_ID);
        const code = codeFrom(setup.notices);

        Array.from({ length: MAX_FAILED_TRIES }, () => '/start WRONGCODE')
            .forEach((text) => {
                setup.telegram.receive(text, 99);
            });
        setup.telegram.receive(`/start ${code}`);
        await vi.waitFor(() => {
            expect(setup.notices.at(-1))
                .toContain('too many times');
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('refuses a code after it expired', async () => {
        let now = 1000;
        const setup = makeBridge({ now: () => now });

        bridges.push(setup.bridge);
        await setup.bridge.startPairing(BOT_ID);
        now += PAIRING_LIFETIME_MS + 1;
        setup.telegram.receive(`/start ${codeFrom(setup.notices)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('passes the owner\'s text to the bot and ignores everyone else', async () => {
        const setup = makeBridge();

        await pair(setup);
        setup.telegram.receive('hello from a stranger', 7, { id: 700, type: 'private' });
        setup.telegram.receive('hello bot');
        await vi.waitFor(() => {
            expect(setup.sentToBot)
                .toEqual(['hello bot']);
        });
        expect(setup.telegram.sent.map(message => message.chatId))
            .not.toContain(700);
    });

    it('sends the replies of a turn that Telegram started, and nothing after it ends', async () => {
        const setup = makeBridge();

        await pair(setup);
        setup.emit(assistantText('a reply nobody asked for on Telegram'));
        setup.telegram.receive('what is up');
        await vi.waitFor(() => {
            expect(setup.sentToBot)
                .toHaveLength(1);
        });
        setup.emit(assistantText('first part'));
        setup.emit(assistantText('second part'));
        setup.emit({ type: 'turn', botId: BOT_ID, isRunning: false });
        setup.emit(assistantText('a later web reply'));
        await vi.waitFor(() => {
            expect(setup.telegram.sent.slice(1)
                .map(message => message.text))
                .toEqual(['first part', 'second part']);
        });
    });

    it('answers a message with no text', async () => {
        const setup = makeBridge();

        await pair(setup);
        setup.telegram.receive(undefined);
        await vi.waitFor(() => {
            expect(setup.telegram.sent.at(-1)?.text)
                .toBe('Only text messages work here for now.');
        });
    });

    it('forgets the link on disconnect and when the bot is deleted', async () => {
        const first = makeBridge();

        await pair(first);
        await expect(first.bridge.disconnect(BOT_ID)).resolves.toBe(true);
        expect(first.settings.values.size)
            .toBe(0);

        const second = makeBridge();

        await pair(second);
        second.emit({ type: 'botDeleted', botId: BOT_ID });
        await vi.waitFor(() => {
            expect(second.settings.values.size)
                .toBe(0);
        });
        expect(second.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('keeps polling after an answer to Telegram fails', async () => {
        const setup = makeBridge();

        await pair(setup);
        setup.telegram.failNextSend = true;
        setup.telegram.receive(undefined);
        setup.telegram.receive('still there?');
        await vi.waitFor(() => {
            expect(setup.sentToBot)
                .toEqual(['still there?']);
        });
    });

    it('stops sending replies once the bot is idle, even after several queued Telegram messages', async () => {
        const setup = makeBridge();

        await pair(setup);
        setup.telegram.receive('one');
        setup.telegram.receive('two');
        await vi.waitFor(() => {
            expect(setup.sentToBot)
                .toHaveLength(2);
        });
        // ChatService says the bot is idle once, after its queue is empty.
        setup.emit({ type: 'turn', botId: BOT_ID, isRunning: false });
        setup.emit(assistantText('a later web reply'));
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(setup.telegram.sent.map(message => message.text))
            .not.toContain('a later web reply');
    });

    it('pairs again right after a disconnect', async () => {
        const setup = makeBridge();

        await pair(setup);
        await setup.bridge.disconnect(BOT_ID);
        setup.notices.length = 0;
        await pair(setup);
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(true);
    });

    it('listens again for a saved link after a restart', async () => {
        const setup = makeBridge();

        bridges.push(setup.bridge);
        await setup.settings.set(`${LINK_KEY_PREFIX}${BOT_ID}`, JSON.stringify({ userId: OWNER_ID, chatId: OWNER_CHAT }));
        await setup.bridge.resume([BOT_ID, 'bot-2']);
        setup.telegram.receive('back again');
        await vi.waitFor(() => {
            expect(setup.sentToBot)
                .toEqual(['back again']);
        });
    });

    it('resumes from the saved offset and does not send a handled message again', async () => {
        const first = makeBridge();

        await pair(first);
        const handled = first.telegram.receive('do this once');

        await vi.waitFor(() => {
            expect(first.sentToBot)
                .toEqual(['do this once']);
        });
        await first.bridge.close();
        expect(first.settings.values.get(`${OFFSET_KEY_PREFIX}${BOT_ID}`))
            .toBe(String(handled.update_id + 1));

        const second = makeBridge({ settings: first.settings });

        bridges.push(second.bridge);
        second.telegram.replay(handled);
        await second.bridge.resume([BOT_ID]);
        await vi.waitFor(() => {
            expect(second.telegram.offsets.length)
                .toBeGreaterThan(0);
        });
        expect(second.telegram.offsets[0])
            .toBe(handled.update_id + 1);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(second.sentToBot)
            .toEqual([]);
    });
});
