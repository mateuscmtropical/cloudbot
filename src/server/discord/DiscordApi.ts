// A small client for the official Discord API (https://discord.com/developers/docs). Messages arrive over the Gateway,
// a WebSocket the bot opens itself, so the server needs no public address. Node's built-in WebSocket is enough, so there
// is no Discord library. Replies go out over REST. The token only travels in the Identify payload and the Authorization
// header, and no error here names it.

const DISCORD_API_ORIGIN = 'https://discord.com';
const DISCORD_REST_URL = `${DISCORD_API_ORIGIN}/api/v10`;
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
// The REST limit for the content of one message.
const MAX_MESSAGE_CHARACTERS = 2000;
// Direct messages only. This intent is not privileged, and DMs carry their text without the message content intent.
const DIRECT_MESSAGES_INTENT = 1 << 12;
// Close codes after which connecting again with the same token cannot work: bad token, bad or not allowed intents.
const FATAL_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];
const OPCODE_DISPATCH = 0;
const OPCODE_HEARTBEAT = 1;
const OPCODE_IDENTIFY = 2;
const OPCODE_RECONNECT = 7;
const OPCODE_INVALID_SESSION = 9;
const OPCODE_HELLO = 10;
const OPCODE_HEARTBEAT_ACK = 11;

// A direct message from a person. Messages of bots and of servers never become one.
interface DiscordMessage {
    authorId: string;
    channelId: string;
    text: string;
}

interface DiscordApi {
    // Opens the Gateway and calls onMessage for each direct message. Ends when the signal aborts. Throws when the
    // connection fails or closes, so the caller can connect again, unless the error is fatal.
    listen: (onMessage: (message: DiscordMessage) => Promise<void>, signal: AbortSignal) => Promise<void>;
    sendMessage: (channelId: string, text: string) => Promise<void>;
}

interface DiscordSocket {
    addEventListener(type: 'open' | 'error' | 'message', listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void;
    addEventListener(type: 'close', listener: (event: { code?: number }) => void, options?: { once?: boolean }): void;
    send(data: string): void;
    close(): void;
}

type DiscordSocketFactory = (url: string) => DiscordSocket;
type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

// The message is safe to log. It never holds the token.
class DiscordApiError extends Error {
    // True when connecting again cannot help, such as a token Discord rejected.
    readonly isFatal: boolean;

    constructor(message: string, isFatal = false) {
        super(message);
        this.name = 'DiscordApiError';
        this.isFatal = isFatal;
    }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

// Splits a long reply into parts Discord accepts. Code points are kept whole.
function splitMessage(text: string): string[] {
    const characters = Array.from(text);
    const partCount = Math.ceil(characters.length / MAX_MESSAGE_CHARACTERS);

    return Array.from({ length: partCount }, (_unused, index) => characters.slice(index * MAX_MESSAGE_CHARACTERS, (index + 1) * MAX_MESSAGE_CHARACTERS)
        .join(''));
}

// The direct message in a MESSAGE_CREATE payload, or undefined for anything else.
function readDirectMessage(data: unknown): DiscordMessage | undefined {
    const record = readRecord(data);
    const author = readRecord(record?.author);

    if (record === undefined || author === undefined || typeof author.id !== 'string' || typeof record.channel_id !== 'string') {
        return undefined;
    }

    // A message of a server has a guild id, and a bot, ours included, is never the owner.
    if (record.guild_id !== undefined || author.bot === true) {
        return undefined;
    }

    return { authorId: author.id, channelId: record.channel_id, text: typeof record.content === 'string' ? record.content : '' };
}

function createWebSocket(url: string): DiscordSocket {
    return new WebSocket(url);
}

function createDiscordApi(token: string, fetchFunction: FetchFunction = fetch, createSocket: DiscordSocketFactory = createWebSocket): DiscordApi {
    async function post(channelId: string, content: string): Promise<void> {
        let response: Response;

        try {
            response = await fetchFunction(`${DISCORD_REST_URL}/channels/${encodeURIComponent(channelId)}/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': `Bot ${token}`,
                    'user-agent': 'DiscordBot (https://github.com/mateuscmtropical/cloudbot, 0.1)',
                },
                body: JSON.stringify({ content }),
                redirect: 'error',
            });
        } catch {
            throw new DiscordApiError('Discord could not be reached to send a message.');
        }

        if (!response.ok) {
            throw new DiscordApiError(`Discord refused a message with status ${String(response.status)}.`);
        }
    }

    function listen(onMessage: (message: DiscordMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const socket = createSocket(GATEWAY_URL);
            let heartbeatTimer: NodeJS.Timeout | undefined;
            let lastSequence: number | null = null;
            let isAcknowledged = true;
            let isDone = false;
            const finish = (error?: Error): void => {
                if (isDone) {
                    return;
                }

                isDone = true;

                if (heartbeatTimer !== undefined) {
                    clearInterval(heartbeatTimer);
                }

                socket.close();

                if (error === undefined) {
                    resolve();
                } else {
                    reject(error);
                }
            };
            const heartbeat = (): void => {
                const beat = JSON.stringify({ op: OPCODE_HEARTBEAT, d: lastSequence });

                socket.send(beat);
            };
            const handlePayload = (payload: Record<string, unknown>): void => {
                const { op, t, s } = payload;

                if (typeof s === 'number') {
                    lastSequence = s;
                }

                if (op === OPCODE_HELLO) {
                    const interval = readRecord(payload.d)?.heartbeat_interval;

                    if (typeof interval !== 'number') {
                        finish(new DiscordApiError('Discord sent a hello in an unknown shape.'));

                        return;
                    }

                    heartbeatTimer = setInterval(() => {
                        // No acknowledgement since the last beat means the connection is dead.
                        if (!isAcknowledged) {
                            finish(new DiscordApiError('The Discord connection stopped answering.'));

                            return;
                        }

                        isAcknowledged = false;
                        heartbeat();
                    }, interval);
                    const identify = JSON.stringify({
                        op: OPCODE_IDENTIFY,
                        d: { token, intents: DIRECT_MESSAGES_INTENT, properties: { os: 'linux', browser: 'cloudbot', device: 'cloudbot' } },
                    });

                    socket.send(identify);
                } else if (op === OPCODE_HEARTBEAT) {
                    heartbeat();
                } else if (op === OPCODE_HEARTBEAT_ACK) {
                    isAcknowledged = true;
                } else if (op === OPCODE_RECONNECT || op === OPCODE_INVALID_SESSION) {
                    // A new connection identifies again. Messages sent while it was down are not replayed.
                    finish(new DiscordApiError('Discord asked to connect again.'));
                } else if (op === OPCODE_DISPATCH && t === 'MESSAGE_CREATE') {
                    const message = readDirectMessage(payload.d);

                    if (message !== undefined) {
                        // One message that fails never closes the connection.
                        onMessage(message)
                            .catch(() => {
                                console.error('A Discord message could not be handled.');
                            });
                    }
                }
            };

            socket.addEventListener('message', (event) => {
                try {
                    const frame = String(event.data);
                    const parsed: unknown = JSON.parse(frame);
                    const payload = readRecord(parsed);

                    if (payload !== undefined) {
                        handlePayload(payload);
                    }
                } catch {
                    // A frame that is not JSON is ignored.
                }
            });
            socket.addEventListener('error', () => {
                finish(new DiscordApiError('The Discord connection failed.'));
            });
            socket.addEventListener('close', (event) => {
                const code = event.code ?? 0;

                const isFatal = FATAL_CLOSE_CODES.includes(code);

                finish(new DiscordApiError(`The Discord connection closed with code ${String(code)}.`, isFatal));
            });
            signal.addEventListener('abort', () => {
                finish();
            }, { once: true });

            if (signal.aborted) {
                finish();
            }
        });
    }

    return {
        listen,
        async sendMessage(channelId: string, text: string): Promise<void> {
            const parts = splitMessage(text);

            // Parts go one after the other, so they arrive in order.
            const start = Promise.resolve();
            const sent = parts.reduce(async (previous, part) => {
                await previous;
                await post(channelId, part);
            }, start);

            await sent;
        },
    };
}

export { DISCORD_API_ORIGIN, DiscordApiError, GATEWAY_URL, MAX_MESSAGE_CHARACTERS, createDiscordApi, readDirectMessage, splitMessage };
export type { DiscordApi, DiscordMessage, DiscordSocket, DiscordSocketFactory, FetchFunction };
