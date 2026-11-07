import { APPROVAL_WAITING_TEXT, MAX_FAILED_TRIES, MessengerBridge, PAIRING_LIFETIME_MS, SCREEN_WAITING_TEXT, isAborted, waitFor } from '../messenger/MessengerBridge.ts';
import type { MessengerBridgeOptions, MessengerChat, MessengerSettings } from '../messenger/MessengerBridge.ts';
import type { TelegramApi, TelegramMessage, TelegramUpdate } from './TelegramApi.ts';

type TelegramChat = MessengerChat;
type TelegramSettings = MessengerSettings;

interface TelegramBridgeOptions extends MessengerBridgeOptions {
    createApi: (token: string) => TelegramApi;
    // How long to wait after a failed poll. Tests make it short.
    retryDelayMs?: number;
}

// The one Telegram account and private chat a bot answers.
interface TelegramLink {
    userId: number;
    chatId: number;
}

interface Poller {
    controller: AbortController;
    done: Promise<void>;
}

const LINK_KEY_PREFIX = 'telegram.link.';
const OFFSET_KEY_PREFIX = 'telegram.offset.';
// The long poll asks Telegram to hold the request this long when there is nothing new.
const POLL_TIMEOUT_SECONDS = 30;
const DEFAULT_RETRY_DELAY_MS = 5000;
const START_COMMAND_PATTERN = /^\/start\s+(\S+)\s*$/;
const CONNECTED_TEXT = 'Connected. Messages you send here go to your bot, and its replies come back here.';
const TEXT_ONLY_TEXT = 'Only text messages work here for now.';
const NOT_SENT_TEXT = 'Your message could not be sent to the bot. Try again in the web app.';

function readLink(stored: string): TelegramLink | undefined {
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

// Connects a bot to one Telegram account. The owner saves the Telegram bot token, the bot posts a one-time code in the
// web chat, and the owner sends /start with the code to the Telegram bot. From then on only that account, in its private
// chat, can talk to the bot. Anything else that reaches the Telegram bot is ignored with no answer.
class TelegramBridge extends MessengerBridge<TelegramLink> {
    protected readonly label = 'Telegram';
    protected readonly linkKeyPrefix = LINK_KEY_PREFIX;
    protected readonly extraKeyPrefixes = [OFFSET_KEY_PREFIX];
    private readonly createApi: (token: string) => TelegramApi;
    private readonly retryDelayMs: number;
    private readonly pollers = new Map<string, Poller>();

    constructor(options: TelegramBridgeOptions) {
        super(options);
        this.createApi = options.createApi;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
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

    protected parseLink(stored: string): TelegramLink | undefined {
        return readLink(stored);
    }

    protected pairingNotice(code: string): string {
        return `Telegram code: ${code}\n\nSend /start ${code} to your Telegram bot within 10 minutes. Only the account that sends it can talk to this bot there.`;
    }

    protected async sendReply(_botId: string, link: TelegramLink, token: string, text: string): Promise<void> {
        const api = this.createApi(token);

        await api.sendMessage(link.chatId, text);
    }

    protected stopTransport(botId: string): Promise<void> {
        const poller = this.pollers.get(botId);

        // The aborted poll leaves the map now, so a pairing started right after this gets a poll of its own.
        poller?.controller.abort();
        this.pollers.delete(botId);

        return poller?.done ?? Promise.resolve();
    }

    protected startTransport(botId: string): void {
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

        await this.relay(botId, text, () => api.sendMessage(link.chatId, NOT_SENT_TEXT));
    }

    private async tryPairing(botId: string, api: TelegramApi, message: TelegramMessage, code: string): Promise<void> {
        if (message.from === undefined) {
            return;
        }

        const isAccepted = await this.acceptCode(botId, code);

        if (!isAccepted) {
            return;
        }

        const link = { userId: message.from.id, chatId: message.chat.id };

        await this.saveLink(botId, link);
        await api.sendMessage(link.chatId, CONNECTED_TEXT);
        await this.announceConnected(botId);
    }
}

export { APPROVAL_WAITING_TEXT, LINK_KEY_PREFIX, MAX_FAILED_TRIES, OFFSET_KEY_PREFIX, PAIRING_LIFETIME_MS, SCREEN_WAITING_TEXT, TelegramBridge };
export type { TelegramBridgeOptions, TelegramChat, TelegramLink, TelegramSettings };
