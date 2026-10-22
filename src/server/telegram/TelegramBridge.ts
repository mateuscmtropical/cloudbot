import { randomInt } from 'node:crypto';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import type { TelegramApi, TelegramMessage, TelegramUpdate } from './TelegramApi.ts';

// The bot's chat as the bridge sees it. ChatService in production.
interface TelegramChat {
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    subscribe: (botId: string, listener: (event: ChatEvent) => void) => () => void;
    // Posts a line in the bot's web chat. The pairing code goes here, never to the model.
    postNotice: (botId: string, text: string) => Promise<void>;
}

interface TelegramSettings {
    get: (key: string) => Promise<string | undefined>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}

interface TelegramBridgeOptions {
    chat: TelegramChat;
    settings: TelegramSettings;
    // The Telegram bot token the owner saved for this bot, or undefined when there is none.
    readToken: (botId: string) => string | undefined;
    createApi: (token: string) => TelegramApi;
    now?: () => number;
    // How long to wait after a failed poll. Tests make it short.
    retryDelayMs?: number;
}

// The one Telegram account and private chat a bot answers.
interface TelegramLink {
    userId: number;
    chatId: number;
}

interface Pairing {
    code: string;
    expiresAt: number;
    failedTries: number;
}

interface Poller {
    controller: AbortController;
    done: Promise<void>;
}

const LINK_KEY_PREFIX = 'telegram.link.';
const OFFSET_KEY_PREFIX = 'telegram.offset.';
const MS_PER_MINUTE = 60_000;
const PAIRING_LIFETIME_MS = 10 * MS_PER_MINUTE;
// A wrong code ends the pairing after this many tries, so a stranger cannot guess it.
const MAX_FAILED_TRIES = 5;
// No 0, O, 1 or I, so the code is easy to read and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
// The long poll asks Telegram to hold the request this long when there is nothing new.
const POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 5000;
const START_COMMAND_PATTERN = /^\/start\s+(\S+)\s*$/;
const CONNECTED_TEXT = 'Connected. Messages you send here go to your bot, and its replies come back here.';
const TEXT_ONLY_TEXT = 'Only text messages work here for now.';
const NOT_SENT_TEXT = 'Your message could not be sent to the bot. Try again in the web app.';

function readLink(stored: string | undefined): TelegramLink | undefined {
    if (stored === undefined) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(stored);

        if (typeof parsed === 'object' && parsed !== null) {
            const userId: unknown = Reflect.get(parsed, 'userId');
            const chatId: unknown = Reflect.get(parsed, 'chatId');

            if (typeof userId === 'number' && typeof chatId === 'number') {
                return { userId, chatId };
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function readOffset(stored: string | undefined): number | undefined {
    if (stored === undefined) {
        return undefined;
    }

    const offset = Number(stored);

    return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

function newPairingCode(): string {
    return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
        .join('');
}

// Read through a call, so a check after an await sees the signal as it is now.
function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, delayMs);

        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

// Connects a bot to one Telegram account. The owner saves the Telegram bot token, the bot posts a one-time code in the
// web chat, and the owner sends /start with the code to the Telegram bot. From then on only that account, in its private
// chat, can talk to the bot. Anything else that reaches the Telegram bot is ignored with no answer.
class TelegramBridge {
    private readonly chat: TelegramChat;
    private readonly settings: TelegramSettings;
    private readonly readToken: (botId: string) => string | undefined;
    private readonly createApi: (token: string) => TelegramApi;
    private readonly now: () => number;
    private readonly retryDelayMs: number;
    private readonly pairings = new Map<string, Pairing>();
    private readonly pollers = new Map<string, Poller>();
    private readonly links = new Map<string, TelegramLink>();
    private readonly unsubscribers = new Map<string, () => void>();
    // Bots with a message from Telegram whose turns have not all ended. ChatService says a bot is idle once, after its
    // queue is empty, so this is a flag, not a count. Replies go back to Telegram while it is set.
    private readonly waitingBots = new Set<string>();
    // Replies of each bot go out one after the other, so they arrive in order.
    private readonly replyQueues = new Map<string, Promise<void>>();

    constructor(options: TelegramBridgeOptions) {
        this.chat = options.chat;
        this.settings = options.settings;
        this.readToken = options.readToken;
        this.createApi = options.createApi;
        this.now = options.now ?? (() => Date.now());
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    }

    // Starts listening again for the bots that were connected before a restart.
    async resume(botIds: string[]): Promise<void> {
        const reads = botIds.map(async (botId) => {
            const stored = await this.settings.get(`${LINK_KEY_PREFIX}${botId}`);

            return { botId, link: readLink(stored) };
        });
        const links = await Promise.all(reads);

        links.forEach(({ botId, link }) => {
            if (link !== undefined) {
                this.attach(botId, link);
            }
        });
    }

    isConnected(botId: string): boolean {
        return this.links.has(botId);
    }

    // Posts a new code in the web chat. Returns false when the bot has no Telegram token saved.
    async startPairing(botId: string): Promise<boolean> {
        if (this.readToken(botId) === undefined) {
            return false;
        }

        const code = newPairingCode();

        this.pairings.set(botId, { code, expiresAt: this.now() + PAIRING_LIFETIME_MS, failedTries: 0 });
        this.ensurePolling(botId);
        await this.chat.postNotice(botId, `Telegram code: ${code}\n\nSend /start ${code} to your Telegram bot within 10 minutes. Only the account that sends it can talk to this bot there.`);

        return true;
    }

    // Forgets the Telegram account and stops listening. Returns false when the bot was not connected.
    async disconnect(botId: string): Promise<boolean> {
        const wasConnected = this.links.has(botId) || this.pairings.has(botId);
        const poller = this.pollers.get(botId);

        this.pairings.delete(botId);
        this.detach(botId);
        // Wait for a poll that is still saving its offset, so it cannot write the key back after the delete below.
        await poller?.done;
        await this.settings.delete(`${LINK_KEY_PREFIX}${botId}`);
        await this.settings.delete(`${OFFSET_KEY_PREFIX}${botId}`);

        return wasConnected;
    }

    // Stops every poll, for a clean shutdown. Links stay saved.
    async close(): Promise<void> {
        const pollers = [...this.pollers.values()];

        pollers.forEach((poller) => {
            poller.controller.abort();
        });
        const finished = pollers.map(poller => poller.done);

        await Promise.all(finished);
    }

    private attach(botId: string, link: TelegramLink): void {
        this.links.set(botId, link);

        if (!this.unsubscribers.has(botId)) {
            const unsubscribe = this.chat.subscribe(botId, (event) => {
                this.forward(botId, event);
            });

            this.unsubscribers.set(botId, unsubscribe);
        }

        this.ensurePolling(botId);
    }

    private detach(botId: string): void {
        this.links.delete(botId);
        this.waitingBots.delete(botId);
        this.replyQueues.delete(botId);
        this.unsubscribers.get(botId)?.();
        this.unsubscribers.delete(botId);
        // The aborted poll leaves the map now, so a pairing started right after this gets a poll of its own.
        this.pollers.get(botId)?.controller.abort();
        this.pollers.delete(botId);
    }

    private ensurePolling(botId: string): void {
        if (this.pollers.has(botId)) {
            return;
        }

        const controller = new AbortController();
        let finish: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const stop = (): void => {
            if (this.pollers.get(botId)?.controller === controller) {
                this.pollers.delete(botId);
            }

            finish();
        };
        // Each round starts the next one without waiting on it, so a poll that runs for weeks keeps no chain of promises.
        const step = (offset: number): void => {
            this.pollRound(botId, controller.signal, offset)
                .then((nextOffset) => {
                    if (nextOffset === undefined) {
                        stop();

                        return;
                    }

                    step(nextOffset);
                })
                .catch(() => {
                    console.error('The Telegram poll stopped after an error.');
                    stop();
                });
        };

        this.pollers.set(botId, { controller, done });
        // Telegram confirms an update only when a later poll asks from a higher offset, so resume from the saved one.
        const storedOffset = this.settings.get(`${OFFSET_KEY_PREFIX}${botId}`);

        storedOffset
            .then((stored) => {
                if (controller.signal.aborted) {
                    stop();

                    return;
                }

                const offset = readOffset(stored) ?? 0;

                step(offset);
            })
            .catch(() => {
                console.error('The Telegram poll stopped after an error.');
                stop();
            });
    }

    // A poll runs while the bot is connected or a pairing is open. A missing token stops it.
    private isWanted(botId: string): boolean {
        const pairing = this.pairings.get(botId);

        if (pairing !== undefined && pairing.expiresAt <= this.now()) {
            this.pairings.delete(botId);
        }

        return this.links.has(botId) || this.pairings.has(botId);
    }

    // One long poll and the messages it brought. Returns the next offset, or undefined when the poll should stop.
    private async pollRound(botId: string, signal: AbortSignal, offset: number): Promise<number | undefined> {
        const token = this.readToken(botId);

        if (signal.aborted || !this.isWanted(botId) || token === undefined) {
            return undefined;
        }

        const api = this.createApi(token);
        let updates: TelegramUpdate[];

        try {
            updates = await api.getUpdates(offset, POLL_TIMEOUT_SECONDS, signal);
        } catch {
            if (!isAborted(signal)) {
                // The error never names the address, since it holds the token.
                console.error('Telegram could not be polled. Trying again soon.');
                await waitFor(this.retryDelayMs, signal);
            }

            return offset;
        }

        const nextOffset = updates.reduce((highest, update) => Math.max(highest, update.update_id + 1), offset);
        const start = Promise.resolve(true);
        const handled = updates.reduce(async (previous, update) => {
            const isPreviousHandled = await previous;

            if (!isPreviousHandled || isAborted(signal)) {
                return false;
            }

            if (update.message !== undefined) {
                // One message that fails, such as an answer Telegram refused, never stops the poll.
                await this.handleMessage(botId, api, update.message)
                    .catch(() => {
                        console.error('A Telegram message could not be handled.');
                    });
            }

            return true;
        }, start);
        const hasHandledAll = await handled;

        // A batch cut short by a stop is not saved, so its unhandled updates come again after a restart.
        if (hasHandledAll && updates.length > 0) {
            const nextOffsetText = String(nextOffset);

            await this.settings.set(`${OFFSET_KEY_PREFIX}${botId}`, nextOffsetText);
        }

        return nextOffset;
    }

    private async handleMessage(botId: string, api: TelegramApi, message: TelegramMessage): Promise<void> {
        // Only private chats count. A group could hold anyone.
        if (message.chat.type !== 'private' || message.from === undefined) {
            return;
        }

        const text = message.text?.trim();
        const startMatch = text === undefined ? null : START_COMMAND_PATTERN.exec(text);

        if (startMatch !== null) {
            await this.tryPairing(botId, api, message, startMatch[1] ?? '');

            return;
        }

        const link = this.links.get(botId);

        if (link === undefined || message.from.id !== link.userId || message.chat.id !== link.chatId) {
            return;
        }

        if (text === undefined || text === '') {
            await api.sendMessage(link.chatId, TEXT_ONLY_TEXT);

            return;
        }

        this.waitingBots.add(botId);

        try {
            await this.chat.sendMessage(botId, text);
        } catch {
            await api.sendMessage(link.chatId, NOT_SENT_TEXT);
        }
    }

    private async tryPairing(botId: string, api: TelegramApi, message: TelegramMessage, code: string): Promise<void> {
        const pairing = this.pairings.get(botId);

        if (pairing === undefined || pairing.expiresAt <= this.now() || message.from === undefined) {
            return;
        }

        if (code !== pairing.code) {
            pairing.failedTries += 1;

            if (pairing.failedTries >= MAX_FAILED_TRIES) {
                this.pairings.delete(botId);
                await this.chat.postNotice(botId, 'The Telegram code was tried wrong too many times, so it no longer works. Ask me for a new one.');
            }

            return;
        }

        const link = { userId: message.from.id, chatId: message.chat.id };

        this.pairings.delete(botId);
        const storedLink = JSON.stringify(link);

        await this.settings.set(`${LINK_KEY_PREFIX}${botId}`, storedLink);
        this.attach(botId, link);
        await api.sendMessage(link.chatId, CONNECTED_TEXT);
        await this.chat.postNotice(botId, 'Telegram is connected. Only that Telegram account can talk to this bot there.');
    }

    private forward(botId: string, event: ChatEvent): void {
        if (event.type === 'botDeleted') {
            this.disconnect(botId)
                .catch(() => {
                    console.error('The Telegram link of a deleted bot could not be removed.');
                });

            return;
        }

        const isWaiting = this.waitingBots.has(botId);

        if (event.type === 'turn' && !event.isRunning) {
            this.waitingBots.delete(botId);

            return;
        }

        const link = this.links.get(botId);
        const token = this.readToken(botId);

        if (event.type !== 'message' || !isWaiting || link === undefined || token === undefined) {
            return;
        }

        const { message } = event;

        if (message.role !== 'assistant' || message.body.kind !== 'text' || message.body.text.trim() === '') {
            return;
        }

        const api = this.createApi(token);
        const replyText = message.body.text;
        const previous = this.replyQueues.get(botId) ?? Promise.resolve();
        const next = previous.then(() => api.sendMessage(link.chatId, replyText))
            .catch(() => {
                console.error('A reply could not be sent to Telegram.');
            });

        this.replyQueues.set(botId, next);
    }
}

export { LINK_KEY_PREFIX, MAX_FAILED_TRIES, OFFSET_KEY_PREFIX, PAIRING_LIFETIME_MS, TelegramBridge };
export type { TelegramBridgeOptions, TelegramChat, TelegramLink, TelegramSettings };
