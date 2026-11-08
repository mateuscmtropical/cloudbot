import { MessengerBridge, isAborted, waitFor } from '../messenger/MessengerBridge.ts';
import type { MessengerBridgeOptions } from '../messenger/MessengerBridge.ts';
import { DiscordApiError } from './DiscordApi.ts';
import type { DiscordApi, DiscordMessage } from './DiscordApi.ts';

interface DiscordBridgeOptions extends MessengerBridgeOptions {
    createApi: (token: string) => DiscordApi;
    // How long to wait before connecting again. Tests make it short.
    retryDelayMs?: number;
    // How often a connection checks that it is still wanted. Tests make it short.
    wantedCheckMs?: number;
}

// The one Discord account and direct message channel a bot answers. Discord ids are numbers too big for JSON, so text.
interface DiscordLink {
    userId: string;
    channelId: string;
}

interface Listener {
    controller: AbortController;
    done: Promise<void>;
}

interface GatewayApi {
    api?: DiscordApi;
    token?: string;
}

const LINK_KEY_PREFIX = 'discord.link.';
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_WANTED_CHECK_MS = 30_000;
const PAIR_COMMAND_PATTERN = /^pair\s+(\S+)\s*$/i;
const CONNECTED_TEXT = 'Connected. Messages you send here go to your bot, and its replies come back here.';
const TEXT_ONLY_TEXT = 'Only text messages work here for now.';
const NOT_SENT_TEXT = 'Your message could not be sent to the bot. Try again in the web app.';

function readLink(stored: string): DiscordLink | undefined {
    try {
        const parsed: unknown = JSON.parse(stored);

        if (typeof parsed === 'object' && parsed !== null) {
            const userId: unknown = Reflect.get(parsed, 'userId');
            const channelId: unknown = Reflect.get(parsed, 'channelId');

            if (typeof userId === 'string' && typeof channelId === 'string') {
                return { userId, channelId };
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

// Connects a bot to one Discord account. The owner saves the Discord bot token, the bot posts a one-time code in the
// web chat, and the owner sends "pair" with the code to the Discord bot in a direct message. From then on only that
// account, in that direct message channel, can talk to the bot. Anything else that reaches the Discord bot is ignored
// with no answer. Servers are never listened to, since the Gateway connection asks for direct messages only.
class DiscordBridge extends MessengerBridge<DiscordLink> {
    protected readonly label = 'Discord';
    protected readonly linkKeyPrefix = LINK_KEY_PREFIX;
    protected readonly extraKeyPrefixes: string[] = [];
    private readonly createApi: (token: string) => DiscordApi;
    private readonly retryDelayMs: number;
    private readonly wantedCheckMs: number;
    private readonly listeners = new Map<string, Listener>();

    constructor(options: DiscordBridgeOptions) {
        super(options);
        this.createApi = options.createApi;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        this.wantedCheckMs = options.wantedCheckMs ?? DEFAULT_WANTED_CHECK_MS;
    }

    // Closes every connection, for a clean shutdown. Links stay saved.
    async close(): Promise<void> {
        const listeners = [...this.listeners.values()];

        listeners.forEach((listener) => {
            listener.controller.abort();
        });
        const finished = listeners.map(listener => listener.done);

        await Promise.all(finished);
    }

    protected parseLink(stored: string): DiscordLink | undefined {
        return readLink(stored);
    }

    protected pairingNotice(code: string): string {
        return `Discord code: ${code}\n\nSend "pair ${code}" to your Discord bot in a direct message within 10 minutes. Only the account that sends it can talk to this bot there.`;
    }

    protected async sendReply(_botId: string, link: DiscordLink, token: string, text: string): Promise<void> {
        const api = this.createApi(token);

        await api.sendMessage(link.channelId, text);
    }

    protected stopTransport(botId: string): Promise<void> {
        const listener = this.listeners.get(botId);

        // The aborted connection leaves the map now, so a pairing started right after this gets one of its own.
        listener?.controller.abort();
        this.listeners.delete(botId);

        return listener?.done ?? Promise.resolve();
    }

    protected startTransport(botId: string): void {
        if (this.listeners.has(botId)) {
            return;
        }

        const controller = new AbortController();
        let finish: () => void = () => undefined;
        const done = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const stop = (): void => {
            if (this.listeners.get(botId)?.controller === controller) {
                this.listeners.delete(botId);
            }

            finish();
        };
        // The Gateway session lives in the api, so every round of this listener shares one api per token. That lets a
        // round resume the session of the one before it.
        const gateway: GatewayApi = {};
        // Each round starts the next one without waiting on it, so a bot that stays online for weeks keeps no chain of promises.
        const step = (): void => {
            this.connectRound(botId, controller, gateway)
                .then((isContinuing) => {
                    if (isContinuing) {
                        step();
                    } else {
                        stop();
                    }
                })
                .catch(() => {
                    console.error('The Discord connection stopped after an error.');
                    stop();
                });
        };

        this.listeners.set(botId, { controller, done });
        step();
    }

    // One connection to the Gateway until it ends. Returns false when the bot should stop listening.
    private async connectRound(botId: string, controller: AbortController, gateway: GatewayApi): Promise<boolean> {
        const { signal } = controller;
        const token = this.readToken(botId);

        if (signal.aborted || !this.isWanted(botId) || token === undefined) {
            return false;
        }

        // A new token is a new bot, so it starts a new session.
        if (gateway.api === undefined || gateway.token !== token) {
            gateway.api = this.createApi(token);
            gateway.token = token;
        }

        const { api } = gateway;
        // Messages are handled one after the other, so the bot gets them in the order they were sent.
        let queue = Promise.resolve();
        const onMessage = (message: DiscordMessage): Promise<void> => {
            queue = queue.then(() => this.handleMessage(botId, api, message))
                .catch(() => {
                    console.error('A Discord message could not be handled.');
                });

            return queue;
        };
        // An open pairing that ran out ends the connection, since a long one would not notice.
        const wantedTimer = setInterval(() => {
            if (!this.isWanted(botId)) {
                controller.abort();
            }
        }, this.wantedCheckMs);

        try {
            await api.listen(onMessage, signal);
        } catch (error: unknown) {
            if (error instanceof DiscordApiError && error.isFatal) {
                console.error('Discord rejected the bot token or its settings, so it stopped listening.');

                return false;
            }

            if (!isAborted(signal)) {
                // The error never names the token.
                console.error('Discord could not be reached. Trying again soon.');
                await waitFor(this.retryDelayMs, signal);
            }
        } finally {
            clearInterval(wantedTimer);
        }

        return !isAborted(signal);
    }

    private async handleMessage(botId: string, api: DiscordApi, message: DiscordMessage): Promise<void> {
        const text = message.text.trim();
        const pairMatch = PAIR_COMMAND_PATTERN.exec(text);

        if (pairMatch !== null) {
            await this.tryPairing(botId, api, message, pairMatch[1] ?? '');

            return;
        }

        const link = this.links.get(botId);

        if (link === undefined || message.authorId !== link.userId || message.channelId !== link.channelId) {
            return;
        }

        if (text === '') {
            await api.sendMessage(link.channelId, TEXT_ONLY_TEXT);

            return;
        }

        await this.relay(botId, text, () => api.sendMessage(link.channelId, NOT_SENT_TEXT));
    }

    private async tryPairing(botId: string, api: DiscordApi, message: DiscordMessage, code: string): Promise<void> {
        // The code alphabet is upper case, and a phone may change the case of what is typed.
        const upperCode = code.toUpperCase();
        const isAccepted = await this.acceptCode(botId, upperCode);

        if (!isAccepted) {
            return;
        }

        const link = { userId: message.authorId, channelId: message.channelId };

        await this.saveLink(botId, link);
        await api.sendMessage(link.channelId, CONNECTED_TEXT);
        await this.announceConnected(botId);
    }
}

export { DiscordBridge, LINK_KEY_PREFIX };
export type { DiscordBridgeOptions, DiscordLink };
