import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import { MAX_FAILED_TRIES, PAIRING_LIFETIME_MS } from '../messenger/MessengerBridge.ts';
import type { MessengerSettings } from '../messenger/MessengerBridge.ts';
import type { DiscordApi, DiscordMessage } from './DiscordApi.ts';
import { DiscordApiError } from './DiscordApi.ts';
import { DiscordBridge, LINK_KEY_PREFIX } from './DiscordBridge.ts';

const BOT_ID = 'bot-1';
const OWNER_ID = '4242';
const OWNER_CHANNEL = '9001';

// A Discord stand-in. Each listen call stays open until it is aborted and hands its handler to the test.
class FakeDiscord {
    readonly sent: { channelId: string; text: string }[] = [];
    listenCount = 0;
    createCount = 0;
    failures: Error[] = [];
    private handler: ((message: DiscordMessage) => Promise<void>) | undefined;

    readonly api: DiscordApi = {
        listen: async (onMessage, signal) => {
            this.listenCount += 1;
            const failure = this.failures.shift();

            if (failure !== undefined) {
                throw failure;
            }

            this.handler = onMessage;
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => {
                    resolve();
                }, { once: true });
            });
        },
        sendMessage: (channelId, text) => {
            this.sent.push({ channelId, text });

            return Promise.resolve();
        },
    };

    async receive(text: string, authorId: string = OWNER_ID, channelId: string = OWNER_CHANNEL): Promise<void> {
        await vi.waitFor(() => {
            expect(this.handler)
                .toBeDefined();
        });
        await this.handler?.({ authorId, channelId, text });
    }
}

function makeSettings(): MessengerSettings & { values: Map<string, string> } {
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
    bridge: DiscordBridge;
    discord: FakeDiscord;
    settings: ReturnType<typeof makeSettings>;
    notices: string[];
    sentToBot: string[];
    emit: (event: ChatEvent) => void;
} {
    const discord = new FakeDiscord();
    const settings = options.settings ?? makeSettings();
    const notices: string[] = [];
    const sentToBot: string[] = [];
    const listeners: ((event: ChatEvent) => void)[] = [];
    const token = 'token' in options ? options.token : 'discord-token';
    const bridge = new DiscordBridge({
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
        createApi: () => {
            discord.createCount += 1;

            return discord.api;
        },
        retryDelayMs: 1,
        wantedCheckMs: 5,
        ...(options.now === undefined ? {} : { now: options.now }),
    });
    const emit = (event: ChatEvent): void => {
        [...listeners].forEach((listener) => {
            listener(event);
        });
    };

    bridges.push(bridge);

    return { bridge, discord, settings, notices, sentToBot, emit };
}

function codeFrom(notices: string[]): string {
    const match = /Discord code: (\S+)/.exec(notices[0] ?? '');

    return match?.[1] ?? '';
}

function assistantText(text: string): ChatEvent {
    return { type: 'message', message: { id: 'm1', botId: BOT_ID, role: 'assistant', createdAt: 1, sequence: 1, body: { kind: 'text', text } } };
}

const bridges: DiscordBridge[] = [];

afterEach(async () => {
    await Promise.all(bridges.map(bridge => bridge.close()));
    bridges.length = 0;
});

async function pair(setup: ReturnType<typeof makeBridge>): Promise<void> {
    await setup.bridge.startPairing(BOT_ID);
    await setup.discord.receive(`pair ${codeFrom(setup.notices)}`);
    expect(setup.bridge.isConnected(BOT_ID))
        .toBe(true);
}

describe('DiscordBridge', () => {
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
            .toBe(JSON.stringify({ userId: OWNER_ID, channelId: OWNER_CHANNEL }));
        expect(setup.discord.sent[0]?.channelId)
            .toBe(OWNER_CHANNEL);
        expect(setup.notices[1])
            .toContain('Discord is connected');
    });

    it('accepts the code in any letter case', async () => {
        const setup = makeBridge();

        await setup.bridge.startPairing(BOT_ID);
        await setup.discord.receive(`PAIR ${codeFrom(setup.notices)
            .toLowerCase()}`);
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(true);
    });

    it('ends the pairing after too many wrong codes', async () => {
        const setup = makeBridge();

        await setup.bridge.startPairing(BOT_ID);
        const code = codeFrom(setup.notices);

        await Array.from({ length: MAX_FAILED_TRIES }, () => 'pair WRONGCODE')
            .reduce(async (previous, text) => {
                await previous;
                await setup.discord.receive(text, '99');
            }, Promise.resolve());
        await setup.discord.receive(`pair ${code}`);
        expect(setup.notices.at(-1))
            .toContain('too many times');
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('refuses a code after it expired', async () => {
        let now = 1000;
        const setup = makeBridge({ now: () => now });

        await setup.bridge.startPairing(BOT_ID);
        now += PAIRING_LIFETIME_MS + 1;
        await setup.discord.receive(`pair ${codeFrom(setup.notices)}`);
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
    });

    it('stops listening when the open pairing runs out', async () => {
        let now = 1000;
        const setup = makeBridge({ now: () => now });

        await setup.bridge.startPairing(BOT_ID);
        await vi.waitFor(() => {
            expect(setup.discord.listenCount)
                .toBe(1);
        });
        now += PAIRING_LIFETIME_MS + 1;
        await vi.waitFor(() => {
            expect(setup.discord.sent)
                .toEqual([]);
            expect(setup.bridge.isConnected(BOT_ID))
                .toBe(false);
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(setup.discord.listenCount)
            .toBe(1);
    });

    it('sends only the owner text to the bot and ignores everyone else', async () => {
        const setup = makeBridge();

        await pair(setup);
        await setup.discord.receive('hello bot');
        await setup.discord.receive('let me in', '99');
        await setup.discord.receive('wrong channel', OWNER_ID, '1');
        expect(setup.sentToBot)
            .toEqual(['hello bot']);
        expect(setup.discord.sent)
            .toHaveLength(1);
    });

    it('says only text works when the message has none', async () => {
        const setup = makeBridge();

        await pair(setup);
        await setup.discord.receive('   ');
        expect(setup.discord.sent.at(-1)?.text)
            .toContain('Only text');
    });

    it('sends the replies of a Discord turn back, and then stops', async () => {
        const setup = makeBridge();

        await pair(setup);
        await setup.discord.receive('hello bot');
        setup.emit(assistantText('hi there'));
        setup.emit({ type: 'turn', botId: BOT_ID, isRunning: false });
        setup.emit(assistantText('from the web'));
        await vi.waitFor(() => {
            expect(setup.discord.sent.at(-1)?.text)
                .toBe('hi there');
        });
        expect(setup.discord.sent)
            .toHaveLength(2);
    });

    it('listens again for a saved link after a restart', async () => {
        const settings = makeSettings();

        await pair(makeBridge({ settings }));
        const restarted = makeBridge({ settings });

        await restarted.bridge.resume([BOT_ID]);
        expect(restarted.bridge.isConnected(BOT_ID))
            .toBe(true);
        await restarted.discord.receive('after restart');
        expect(restarted.sentToBot)
            .toEqual(['after restart']);
    });

    it('connects again after a failed connection', async () => {
        const setup = makeBridge();

        setup.discord.failures.push(new DiscordApiError('The Discord connection failed.'));
        await setup.bridge.startPairing(BOT_ID);
        await vi.waitFor(() => {
            expect(setup.discord.listenCount)
                .toBe(2);
        });
        // One api for both connections, so the second one can resume the Gateway session of the first.
        expect(setup.discord.createCount)
            .toBe(1);
    });

    it('does not connect again after Discord rejected the token', async () => {
        const setup = makeBridge();

        setup.discord.failures.push(new DiscordApiError('The Discord connection closed with code 4004.', true));
        await setup.bridge.startPairing(BOT_ID);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(setup.discord.listenCount)
            .toBe(1);
    });

    it('forgets the link on disconnect', async () => {
        const setup = makeBridge();

        await pair(setup);
        await expect(setup.bridge.disconnect(BOT_ID)).resolves.toBe(true);
        expect(setup.bridge.isConnected(BOT_ID))
            .toBe(false);
        expect(setup.settings.values.size)
            .toBe(0);
        await expect(setup.bridge.disconnect(BOT_ID)).resolves.toBe(false);
    });
});
