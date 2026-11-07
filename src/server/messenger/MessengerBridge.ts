import { randomInt } from 'node:crypto';

import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';

// The bot's chat as a bridge sees it. ChatService in production.
interface MessengerChat {
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    subscribe: (botId: string, listener: (event: ChatEvent) => void) => () => void;
    // Posts a line in the bot's web chat. The pairing code goes here, never to the model.
    postNotice: (botId: string, text: string) => Promise<void>;
}

interface MessengerSettings {
    get: (key: string) => Promise<string | undefined>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}

interface MessengerBridgeOptions {
    chat: MessengerChat;
    settings: MessengerSettings;
    // The messenger bot token the owner saved for this bot, or undefined when there is none.
    readToken: (botId: string) => string | undefined;
    now?: () => number;
}

interface Pairing {
    code: string;
    expiresAt: number;
    failedTries: number;
}

const MS_PER_MINUTE = 60_000;
const PAIRING_LIFETIME_MS = 10 * MS_PER_MINUTE;
// A wrong code ends the pairing after this many tries, so a stranger cannot guess it.
const MAX_FAILED_TRIES = 5;
// No 0, O, 1 or I, so the code is easy to read and type.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
// The card text stays in the web app, and nothing can be answered from the messenger.
const APPROVAL_WAITING_TEXT = 'The bot is waiting for your approval. Open the web app to answer it.';
const SCREEN_WAITING_TEXT = 'The bot needs you on its screen. Open the web app to take it.';

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

// What every messenger bridge shares. The owner saves the messenger bot token, the bot posts a one-time code in the web
// chat, and the owner sends the code to the messenger bot. From then on only that account, in its private chat, can talk
// to the bot. A subclass adds how messages arrive and how replies leave.
abstract class MessengerBridge<Link> {
    protected abstract readonly label: string;
    protected abstract readonly linkKeyPrefix: string;
    // Other settings of a bot that a disconnect forgets, as key prefixes.
    protected abstract readonly extraKeyPrefixes: string[];
    protected readonly chat: MessengerChat;
    protected readonly settings: MessengerSettings;
    protected readonly readToken: (botId: string) => string | undefined;
    protected readonly now: () => number;
    protected readonly pairings = new Map<string, Pairing>();
    protected readonly links = new Map<string, Link>();
    private readonly unsubscribers = new Map<string, () => void>();
    // Bots with a message from the messenger whose turns have not all ended. ChatService says a bot is idle once, after
    // its queue is empty, so this is a flag, not a count. Replies go back to the messenger while it is set.
    private readonly waitingBots = new Set<string>();
    // Replies of each bot go out one after the other, so they arrive in order.
    private readonly replyQueues = new Map<string, Promise<void>>();
    // Cards already announced in the current messenger turn. A card is published again when it is answered.
    private readonly announcedMessages = new Map<string, Set<string>>();

    constructor(options: MessengerBridgeOptions) {
        this.chat = options.chat;
        this.settings = options.settings;
        this.readToken = options.readToken;
        this.now = options.now ?? (() => Date.now());
    }

    protected abstract parseLink(stored: string): Link | undefined;

    // The web chat text that holds the code and says where to send it.
    protected abstract pairingNotice(code: string): string;

    // Starts listening for messages of the bot. Called again while it already listens, it does nothing.
    protected abstract startTransport(botId: string): void;

    // Stops listening. The promise ends when nothing of the listener is running any more.
    protected abstract stopTransport(botId: string): Promise<void>;

    protected abstract sendReply(botId: string, link: Link, token: string, text: string): Promise<void>;

    abstract close(): Promise<void>;

    // Starts listening again for the bots that were connected before a restart.
    async resume(botIds: string[]): Promise<void> {
        const reads = botIds.map(async (botId) => {
            const stored = await this.settings.get(`${this.linkKeyPrefix}${botId}`);

            return { botId, link: stored === undefined ? undefined : this.parseLink(stored) };
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

    // Posts a new code in the web chat. Returns false when the bot has no token saved.
    async startPairing(botId: string): Promise<boolean> {
        if (this.readToken(botId) === undefined) {
            return false;
        }

        const code = newPairingCode();

        this.pairings.set(botId, { code, expiresAt: this.now() + PAIRING_LIFETIME_MS, failedTries: 0 });
        this.startTransport(botId);
        const notice = this.pairingNotice(code);

        await this.chat.postNotice(botId, notice);

        return true;
    }

    // Forgets the account and stops listening. Returns false when the bot was not connected.
    async disconnect(botId: string): Promise<boolean> {
        const wasConnected = this.links.has(botId) || this.pairings.has(botId);

        this.pairings.delete(botId);
        // Wait for a listener that is still saving its state, so it cannot write a key back after the deletes below.
        await this.detach(botId);
        await this.settings.delete(`${this.linkKeyPrefix}${botId}`);
        const deletes = this.extraKeyPrefixes.map(prefix => this.settings.delete(`${prefix}${botId}`));

        await Promise.all(deletes);

        return wasConnected;
    }

    // Listening runs while the bot is connected or a pairing is open. A missing token stops it.
    protected isWanted(botId: string): boolean {
        const pairing = this.pairings.get(botId);

        if (pairing !== undefined && pairing.expiresAt <= this.now()) {
            this.pairings.delete(botId);
        }

        return this.links.has(botId) || this.pairings.has(botId);
    }

    // True when the code is the open one. A wrong code counts, and too many end the pairing.
    protected async acceptCode(botId: string, code: string): Promise<boolean> {
        const pairing = this.pairings.get(botId);

        if (pairing === undefined || pairing.expiresAt <= this.now()) {
            return false;
        }

        if (code !== pairing.code) {
            pairing.failedTries += 1;

            if (pairing.failedTries >= MAX_FAILED_TRIES) {
                this.pairings.delete(botId);
                await this.chat.postNotice(botId, `The ${this.label} code was tried wrong too many times, so it no longer works. Ask me for a new one.`);
            }

            return false;
        }

        this.pairings.delete(botId);

        return true;
    }

    // Saves the account that sent the right code and starts answering it only.
    protected async saveLink(botId: string, link: Link): Promise<void> {
        const storedLink = JSON.stringify(link);

        await this.settings.set(`${this.linkKeyPrefix}${botId}`, storedLink);
        this.attach(botId, link);
    }

    protected async announceConnected(botId: string): Promise<void> {
        await this.chat.postNotice(botId, `${this.label} is connected. Only that ${this.label} account can talk to this bot there.`);
    }

    // Sends the owner's text to the bot. The failure callback tells the owner it did not arrive.
    protected async relay(botId: string, text: string, onFailure: () => Promise<void>): Promise<void> {
        this.waitingBots.add(botId);

        try {
            await this.chat.sendMessage(botId, text);
        } catch {
            await onFailure();
        }
    }

    private attach(botId: string, link: Link): void {
        this.links.set(botId, link);

        if (!this.unsubscribers.has(botId)) {
            const unsubscribe = this.chat.subscribe(botId, (event) => {
                this.forward(botId, event);
            });

            this.unsubscribers.set(botId, unsubscribe);
        }

        this.startTransport(botId);
    }

    private detach(botId: string): Promise<void> {
        this.links.delete(botId);
        this.waitingBots.delete(botId);
        this.replyQueues.delete(botId);
        this.announcedMessages.delete(botId);
        this.unsubscribers.get(botId)?.();
        this.unsubscribers.delete(botId);

        return this.stopTransport(botId);
    }

    private forward(botId: string, event: ChatEvent): void {
        if (event.type === 'botDeleted') {
            this.disconnect(botId)
                .catch(() => {
                    console.error(`The ${this.label} link of a deleted bot could not be removed.`);
                });

            return;
        }

        const isWaiting = this.waitingBots.has(botId);

        if (event.type === 'turn' && !event.isRunning) {
            this.waitingBots.delete(botId);
            this.announcedMessages.delete(botId);

            return;
        }

        const link = this.links.get(botId);
        const token = this.readToken(botId);

        if (event.type !== 'message' || !isWaiting || link === undefined || token === undefined) {
            return;
        }

        const { message } = event;

        if (message.role !== 'assistant') {
            return;
        }

        const replyText = this.replyTextFor(botId, message);

        if (replyText === undefined) {
            return;
        }

        const previous = this.replyQueues.get(botId) ?? Promise.resolve();
        const next = previous.then(() => this.sendReply(botId, link, token, replyText))
            .catch(() => {
                console.error(`A reply could not be sent to ${this.label}.`);
            });

        this.replyQueues.set(botId, next);
    }

    // The text that goes to the messenger for an assistant message, or undefined when it stays in the web app.
    private replyTextFor(botId: string, message: ChatMessage): string | undefined {
        const { body } = message;

        if (body.kind === 'text') {
            return body.text.trim() === '' ? undefined : body.text;
        }

        const isOpenApproval = body.kind === 'choice' && body.isApproval === true && body.chosenId === undefined;

        if (!isOpenApproval && body.kind !== 'screenLink') {
            return undefined;
        }

        const announced = this.announcedMessages.get(botId) ?? new Set<string>();

        if (announced.has(message.id)) {
            return undefined;
        }

        announced.add(message.id);
        this.announcedMessages.set(botId, announced);

        return isOpenApproval ? APPROVAL_WAITING_TEXT : SCREEN_WAITING_TEXT;
    }
}

export { APPROVAL_WAITING_TEXT, MAX_FAILED_TRIES, MessengerBridge, PAIRING_LIFETIME_MS, SCREEN_WAITING_TEXT, isAborted, waitFor };
export type { MessengerBridgeOptions, MessengerChat, MessengerSettings };
