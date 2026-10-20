import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';

import type { ChatEvent } from '../../shared/chatTypes.ts';
import { DEFAULT_MESSAGE_PAGE_LIMIT, MAX_MESSAGE_PAGE_LIMIT, TurnInProgressError } from './ChatService.ts';
import type { ChatService, MessagePageOptions } from './ChatService.ts';
import { SetupAnswerError } from '../setup/SetupConversation.ts';
import type { SetupAction } from '../setup/SetupConversation.ts';

interface ChatErrorResponse {
    error: string;
}

const BOT_NOT_FOUND: ChatErrorResponse = { error: 'No bot has this id.' };
const EMPTY_TEXT: ChatErrorResponse = { error: 'Send a non-empty "text" string.' };
const TURN_IN_PROGRESS: ChatErrorResponse = { error: 'This bot is still answering. Stop it or wait.' };
const INVALID_BEFORE: ChatErrorResponse = { error: '"before" must be a message sequence number, 1 or more.' };
const INVALID_LIMIT: ChatErrorResponse = { error: '"limit" must be a whole number, 1 or more.' };
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
// An SSE comment line. Clients ignore it, and it keeps idle proxies from closing the stream.
const HEARTBEAT_FRAME = ': heartbeat\n\n';

interface ChatRoutesOptions {
    heartbeatIntervalMs?: number;
}

// Only plain digits count. Anything else, including 0, a sign or a decimal, is rejected.
function parsePositiveInteger(rawValue: string): number | undefined {
    if (!/^\d+$/.test(rawValue)) {
        return undefined;
    }

    const parsedNumber = Number(rawValue);

    return Number.isSafeInteger(parsedNumber) && parsedNumber >= 1 ? parsedNumber : undefined;
}

function isErrorResponse(parsedPage: MessagePageOptions | ChatErrorResponse): parsedPage is ChatErrorResponse {
    return 'error' in parsedPage;
}

// A limit above the maximum is capped, not rejected, so a client can ask for "as many as allowed".
function parseMessagePage(beforeText: string | undefined, limitText: string | undefined): MessagePageOptions | ChatErrorResponse {
    const beforeSequence = beforeText === undefined ? undefined : parsePositiveInteger(beforeText);

    if (beforeText !== undefined && beforeSequence === undefined) {
        return INVALID_BEFORE;
    }

    const requestedLimit = limitText === undefined ? DEFAULT_MESSAGE_PAGE_LIMIT : parsePositiveInteger(limitText);

    if (requestedLimit === undefined) {
        return INVALID_LIMIT;
    }

    return {
        limit: Math.min(requestedLimit, MAX_MESSAGE_PAGE_LIMIT),
        beforeSequence,
    };
}

function readText(requestBody: unknown): string | undefined {
    if (typeof requestBody !== 'object' || requestBody === null) {
        return undefined;
    }

    const candidate: unknown = Reflect.get(requestBody, 'text');

    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
        return undefined;
    }

    return candidate;
}

// Writes are queued in order, so a burst of events reaches the client in the order it was published.
function createEventWriter(stream: SSEStreamingApi): (event: ChatEvent) => void {
    let pendingWrite: Promise<void> = Promise.resolve();

    return (event: ChatEvent) => {
        const eventData = JSON.stringify(event);

        pendingWrite = pendingWrite.then(() => stream.writeSSE({ data: eventData }));
    };
}

function createChatRoutes(chatService: ChatService, options: ChatRoutesOptions = {}): Hono {
    const routes = new Hono();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const setupActions: SetupAction[] = ['choice', 'code', 'secret'];

    setupActions.forEach((action) => {
        routes.post(`/api/bots/:id/messages/:mid/${action}`, async (context) => {
            const botId = context.req.param('id');
            const messageId = context.req.param('mid');
            const field = action === 'choice' ? 'choiceId' : action === 'secret' ? 'value' : 'code';
            let payload: unknown;

            try {
                payload = await context.req.json();
            } catch {
                return context.json({ error: 'Send a valid JSON body.' }, 400);
            }

            const value: unknown = typeof payload === 'object' && payload !== null ? Reflect.get(payload, field) : undefined;

            if (typeof value !== 'string' || value.trim().length === 0) {
                return context.json({ error: 'Send a non-empty value.' }, 400);
            }

            try {
                const message = await chatService.answerSetup(botId, messageId, action, value);

                return context.json(message);
            } catch (error: unknown) {
                if (error instanceof SetupAnswerError) {
                    return context.json({ error: error.message }, 409);
                }

                // Never pass a dependency error to Hono because it may contain submitted input.
                return context.json({ error: 'Could not save this setup answer. Try again.' }, 500);
            }
        });
    });

    routes.get('/api/bots', async (context) => {
        const bots = await chatService.listBots();

        return context.json(bots);
    });

    routes.get('/api/bots/:id/messages', async (context) => {
        const botId = context.req.param('id');
        const beforeText = context.req.query('before');
        const limitText = context.req.query('limit');
        const parsedPage = parseMessagePage(beforeText, limitText);

        if (isErrorResponse(parsedPage)) {
            return context.json(parsedPage, 400);
        }

        const messages = await chatService.listMessages(botId, parsedPage);

        if (messages === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.json(messages);
    });

    routes.post('/api/bots/:id/messages', async (context) => {
        const botId = context.req.param('id');

        // Invalid JSON counts as a missing text, so it gets the same 400 as an empty body.
        let requestBody: unknown;

        try {
            requestBody = await context.req.json();
        } catch {
            requestBody = undefined;
        }

        const text = readText(requestBody);

        if (text === undefined) {
            return context.json(EMPTY_TEXT, 400);
        }

        try {
            const savedMessage = await chatService.sendMessage(botId, text);

            if (savedMessage === undefined) {
                return context.json(BOT_NOT_FOUND, 404);
            }

            return context.json(savedMessage, 201);
        } catch (error: unknown) {
            if (error instanceof TurnInProgressError) {
                return context.json(TURN_IN_PROGRESS, 409);
            }

            throw error;
        }
    });

    routes.post('/api/bots/:id/stop', async (context) => {
        const botId = context.req.param('id');
        const stopResult = await chatService.stopTurn(botId);

        if (stopResult === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    routes.get('/api/bots/:id/events', async (context) => {
        const botId = context.req.param('id');
        const isBotFound = await chatService.hasBot(botId);

        if (!isBotFound) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        // Hono sends HEAD through the GET handler, so HEAD must stop here or it opens a stream nothing closes.
        if (context.req.method === 'HEAD') {
            return context.body(null, 200);
        }

        const requestSignal = context.req.raw.signal;

        return streamSSE(context, async (stream) => {
            // The client may have left while hasBot was pending, so there is nothing to subscribe for.
            if (requestSignal.aborted) {
                return;
            }

            const writeEvent = createEventWriter(stream);
            const initialEvent: ChatEvent = { type: 'turn', botId, isRunning: chatService.isTurnRunning(botId) };

            writeEvent(initialEvent);

            const unsubscribe = chatService.subscribe(botId, writeEvent);
            // Proxies close an idle connection, so a comment line keeps it open.
            const heartbeatTimer = setInterval(() => {
                void stream.write(HEARTBEAT_FRAME);
            }, heartbeatIntervalMs);

            // The handler must stay open until the client leaves, or the stream closes.
            await new Promise<void>((resolve) => {
                let isCleanedUp = false;
                const cleanup = (): void => {
                    if (isCleanedUp) {
                        return;
                    }

                    isCleanedUp = true;
                    clearInterval(heartbeatTimer);
                    unsubscribe();
                    resolve();
                };

                stream.onAbort(cleanup);
                requestSignal.addEventListener('abort', cleanup, { once: true });
            });
        });
    });

    return routes;
}

export { createChatRoutes };
export type { ChatRoutesOptions };
