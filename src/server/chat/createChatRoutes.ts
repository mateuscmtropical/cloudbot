import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';

import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';

import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';
import { MAX_FILES_PER_UPLOAD, readMaxUploadBytes } from '../attachments/saveUpload.ts';
import { DEFAULT_MESSAGE_PAGE_LIMIT, MAX_MESSAGE_PAGE_LIMIT, PendingUploadLimitError, UploadDuringTurnError } from './ChatService.ts';
import type { ChatService, DeleteBotOutcome, MessagePageOptions } from './ChatService.ts';
import { BotDeletingError } from '../bots/BotDeletingError.ts';
import { SetupAnswerError } from '../setup/SetupConversation.ts';
import type { SetupAction } from '../setup/SetupConversation.ts';

interface ChatErrorResponse {
    error: string;
}

const BOT_NOT_FOUND: ChatErrorResponse = { error: 'No bot has this id.' };
const BOT_DELETING: ChatErrorResponse = { error: 'This bot is being deleted.' };
const INVALID_NAME: ChatErrorResponse = { error: 'Send a name of 1 to 40 characters on one line.' };
const DELETE_FAILED: ChatErrorResponse = { error: 'Could not delete this bot. Try again.' };
// Each refusal has its own text, so the web app can show the owner why.
const DELETE_REFUSED: Record<Exclude<DeleteBotOutcome, 'deleted' | 'missing'>, ChatErrorResponse> = {
    deleting: { error: 'This bot is already being deleted.' },
    last: { error: 'The last bot cannot be deleted.' },
    setup: { error: 'Finish connecting an AI provider in this bot\'s chat before you delete it.' },
    stopping: { error: 'The bot is still stopping. Try again in a moment.' },
    manager: { error: 'This bot manages a channel. Make another member the manager of that channel first.' },
};
const EMPTY_TEXT: ChatErrorResponse = { error: 'Send a non-empty "text" string.' };
const INVALID_BEFORE: ChatErrorResponse = { error: '"before" must be a message sequence number, 1 or more.' };
const INVALID_LIMIT: ChatErrorResponse = { error: '"limit" must be a whole number, 1 or more.' };
const NO_FILE: ChatErrorResponse = { error: 'Send the files as multipart form data.' };
const NO_PENDING_UPLOAD: ChatErrorResponse = { error: 'No file waiting for the next message has this id.' };
const NO_SHARED_FILE: ChatErrorResponse = { error: 'No shared file has this message id.' };
const TOO_LARGE: ChatErrorResponse = { error: 'The upload is larger than CLOUDBOT_MAX_UPLOAD_MB.' };
const UPLOAD_DURING_TURN: ChatErrorResponse = { error: 'Wait until the reply finishes.' };
const TOO_MANY_FILES: ChatErrorResponse = { error: `Send at most ${String(MAX_FILES_PER_UPLOAD)} files at once.` };
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
// An SSE comment line. Clients ignore it, and it keeps idle proxies from closing the stream.
const HEARTBEAT_FRAME = ': heartbeat\n\n';

interface ChatRoutesOptions {
    heartbeatIntervalMs?: number;
    maxUploadBytes?: number;
}

// Only plain digits count. Anything else, including 0, a sign or a decimal, is rejected.
// RFC 5987 leaves out the characters that encodeURIComponent keeps.
function encodeHeaderFileName(name: string): string {
    const encodedName = encodeURIComponent(name);

    return encodedName.replaceAll(/['()*!]/g, character => `%${character.charCodeAt(0)
        .toString(16)
        .toUpperCase()}`);
}

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

// Reads the uploaded files from the form. A body that is not form data has no files.
async function readUploadedFiles(context: Context): Promise<File[]> {
    try {
        const form = await context.req.parseBody({ all: true });
        const values = Object.values(form);
        const entries = values.flat();

        return entries.filter((entry): entry is File => entry instanceof File);
    } catch {
        return [];
    }
}

function createChatRoutes(chatService: ChatService, options: ChatRoutesOptions = {}): Hono {
    const routes = new Hono();
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const maxUploadBytes = options.maxUploadBytes ?? readMaxUploadBytes(process.env);
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

    // The "+" button. The new bot's chat opens with its question about its name and job.
    routes.post('/api/bots', async (context) => {
        const bot = await chatService.createOwnerBot();

        return context.json(bot, 201);
    });

    routes.delete('/api/bots/:id', async (context) => {
        const botId = context.req.param('id');
        let outcome: DeleteBotOutcome;

        try {
            outcome = await chatService.deleteBot(botId);
        } catch (error: unknown) {
            // The owner sees only the generic message. The log keeps the error for the operator.
            console.error('Deleting a bot failed', error);

            return context.json(DELETE_FAILED, 500);
        }

        if (outcome === 'deleted') {
            return context.json({ deleted: true });
        }

        if (outcome === 'missing') {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.json(DELETE_REFUSED[outcome], 409);
    });

    // The owner renames a bot, as the bot can with update_profile.
    routes.put('/api/bots/:id/name', async (context) => {
        const botId = context.req.param('id');
        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const name = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).name : undefined;

        if (typeof name !== 'string') {
            return context.json(INVALID_NAME, 400);
        }

        const outcome = await chatService.renameBot(botId, name);

        if (outcome.kind === 'renamed') {
            return context.json(outcome.bot);
        }

        if (outcome.kind === 'missing') {
            return context.json(BOT_NOT_FOUND, 404);
        }

        if (outcome.kind === 'conflict') {
            return context.json({ error: outcome.reason }, 409);
        }

        return context.json(INVALID_NAME, 400);
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

        // A message sent while the bot is busy is queued, so it is accepted with 201 as well.
        let savedMessage: ChatMessage | undefined;

        try {
            savedMessage = await chatService.sendMessage(botId, text);
        } catch (error: unknown) {
            if (error instanceof BotDeletingError) {
                return context.json(BOT_DELETING, 409);
            }

            throw error;
        }

        if (savedMessage === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.json(savedMessage, 201);
    });

    const tooLarge = (context: Context): Response => context.json(TOO_LARGE, 413);
    const uploadLimit = bodyLimit({ maxSize: maxUploadBytes, onError: tooLarge });

    routes.post(
        '/api/bots/:id/attachments',
        uploadLimit,
        async (context) => {
            const botId = context.req.param('id');
            const files = await readUploadedFiles(context);

            if (files.length === 0) {
                return context.json(NO_FILE, 400);
            }

            if (files.length > MAX_FILES_PER_UPLOAD) {
                return context.json(TOO_MANY_FILES, 400);
            }

            try {
                const attachments = await chatService.saveUploads(botId, files);

                if (attachments === undefined) {
                    return context.json(BOT_NOT_FOUND, 404);
                }

                return context.json(attachments, 201);
            } catch (error: unknown) {
                if (error instanceof UploadDuringTurnError) {
                    return context.json(UPLOAD_DURING_TURN, 409);
                }

                if (error instanceof BotDeletingError) {
                    return context.json(BOT_DELETING, 409);
                }

                if (error instanceof PendingUploadLimitError) {
                    return context.json({ error: error.message }, 413);
                }

                throw error;
            }
        },
    );

    routes.get('/api/bots/:id/messages/:mid/file', async (context) => {
        const botId = context.req.param('id');
        const messageId = context.req.param('mid');
        const sharedFile = await chatService.findSharedFile(botId, messageId);

        if (sharedFile === undefined) {
            return context.json(NO_SHARED_FILE, 404);
        }

        const fileStream = createReadStream(sharedFile.absolutePath);
        const encodedName = encodeHeaderFileName(sharedFile.name);
        const fallbackName = sharedFile.name.replaceAll(/[^\x20-\x7E]|["\\%]/g, '_');

        // An error such as a missing copy ends the stream before any byte, so it becomes a 404 below.
        try {
            await once(fileStream, 'open');
        } catch {
            return context.json(NO_SHARED_FILE, 404);
        }

        context.header('content-type', sharedFile.mimeType);
        const lengthText = String(sharedFile.sizeBytes);

        context.header('content-length', lengthText);
        context.header('content-disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
        context.header('x-content-type-options', 'nosniff');
        context.header('cache-control', 'private, no-store');

        return context.body(Readable.toWeb(fileStream) as ReadableStream);
    });

    routes.get('/api/bots/:id/uploads', async (context) => {
        const botId = context.req.param('id');
        const uploads = await chatService.listPendingUploads(botId);

        if (uploads === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.json(uploads);
    });

    routes.delete('/api/bots/:id/uploads/:uploadId', async (context) => {
        const botId = context.req.param('id');
        const uploadId = context.req.param('uploadId');
        const isRemoved = await chatService.removePendingUpload(botId, uploadId);

        if (isRemoved === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        if (!isRemoved) {
            return context.json(NO_PENDING_UPLOAD, 404);
        }

        return context.body(null, 204);
    });

    routes.post('/api/bots/:id/stop', async (context) => {
        const botId = context.req.param('id');
        const stopResult = await chatService.stopTurn(botId);

        if (stopResult === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    // One stream with the messages of every bot, so the bot list can mark an unread chat and show its newest message.
    routes.get('/api/events', (context) => {
        if (context.req.method === 'HEAD') {
            return context.body(null, 200);
        }

        const requestSignal = context.req.raw.signal;

        return streamSSE(context, async (stream) => {
            if (requestSignal.aborted) {
                return;
            }

            const writeEvent = createEventWriter(stream);
            const unsubscribe = chatService.subscribeToAllBots((event) => {
                if (event.type === 'message' || event.type === 'botDeleted') {
                    writeEvent(event);
                }
            });
            const heartbeatTimer = setInterval(() => {
                void stream.write(HEARTBEAT_FRAME);
            }, heartbeatIntervalMs);

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
            const initialEvent: ChatEvent = { type: 'turn', botId, isRunning: chatService.isBusy(botId) };

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
