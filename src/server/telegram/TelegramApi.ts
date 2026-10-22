// A small client for the official Telegram Bot API (https://core.telegram.org/bots/api). It uses getUpdates long polling,
// so the server needs no public address. The token is part of every request address, so no error here ever names the
// address, and the caller never logs it.

const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
// The Bot API limit for the text of one message, after entities parsing (sendMessage in the docs above).
const MAX_MESSAGE_CHARACTERS = 4096;

interface TelegramUser {
    id: number;
}

interface TelegramChat {
    id: number;
    type: string;
}

interface TelegramMessage {
    chat: TelegramChat;
    from?: TelegramUser | undefined;
    text?: string | undefined;
}

interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage | undefined;
}

interface TelegramApi {
    // Waits up to timeoutSeconds for new updates from the given offset.
    getUpdates: (offset: number, timeoutSeconds: number, signal: AbortSignal) => Promise<TelegramUpdate[]>;
    sendMessage: (chatId: number, text: string) => Promise<void>;
}

type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

// The message is safe to log. It never holds the token or the address.
class TelegramApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TelegramApiError';
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readUpdate(value: unknown): TelegramUpdate | undefined {
    const record = readRecord(value);
    const message = readRecord(record?.message);
    const chat = readRecord(message?.chat);
    const from = readRecord(message?.from);

    if (record === undefined || typeof record.update_id !== 'number') {
        return undefined;
    }

    if (message === undefined || chat === undefined || typeof chat.id !== 'number' || typeof chat.type !== 'string') {
        return { update_id: record.update_id };
    }

    return {
        update_id: record.update_id,
        message: {
            chat: { id: chat.id, type: chat.type },
            from: typeof from?.id === 'number' ? { id: from.id } : undefined,
            text: typeof message.text === 'string' ? message.text : undefined,
        },
    };
}

// Splits a long reply into parts Telegram accepts. Code points are kept whole.
function splitMessage(text: string): string[] {
    const characters = Array.from(text);
    const partCount = Math.ceil(characters.length / MAX_MESSAGE_CHARACTERS);

    return Array.from({ length: partCount }, (_unused, index) => characters.slice(index * MAX_MESSAGE_CHARACTERS, (index + 1) * MAX_MESSAGE_CHARACTERS)
        .join(''));
}

function createTelegramApi(token: string, fetchFunction: FetchFunction = fetch): TelegramApi {
    async function call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
        let response: Response;

        try {
            const requestBody = JSON.stringify(body);

            response = await fetchFunction(`${TELEGRAM_API_ORIGIN}/bot${token}/${method}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: requestBody,
                redirect: 'error',
                ...(signal === undefined ? {} : { signal }),
            });
        } catch (error: unknown) {
            if (signal?.aborted === true) {
                throw error;
            }

            throw new TelegramApiError(`Telegram could not be reached for ${method}.`);
        }

        let parsed: unknown;

        try {
            parsed = await response.json();
        } catch {
            throw new TelegramApiError(`Telegram sent an answer that is not JSON for ${method}, status ${String(response.status)}.`);
        }

        const record = readRecord(parsed);

        if (record?.ok !== true) {
            throw new TelegramApiError(`Telegram refused ${method} with status ${String(response.status)}.`);
        }

        return record.result;
    }

    return {
        async getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]> {
            const result = await call('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message'] }, signal);

            if (!Array.isArray(result)) {
                throw new TelegramApiError('Telegram sent updates in an unknown shape.');
            }

            return result.map(readUpdate)
                .filter(update => update !== undefined);
        },
        async sendMessage(chatId: number, text: string): Promise<void> {
            const parts = splitMessage(text);

            // Parts go one after the other, so they arrive in order.
            const start = Promise.resolve();
            const sent = parts.reduce(async (previous, part) => {
                await previous;
                await call('sendMessage', { chat_id: chatId, text: part });
            }, start);

            await sent;
        },
    };
}

export { MAX_MESSAGE_CHARACTERS, TELEGRAM_API_ORIGIN, TelegramApiError, createTelegramApi, splitMessage };
export type { FetchFunction, TelegramApi, TelegramMessage, TelegramUpdate };
