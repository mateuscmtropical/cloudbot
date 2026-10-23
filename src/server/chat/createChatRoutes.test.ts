import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner } from '../agent/AgentRunner.ts';
import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { ScriptedAgentStep } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { buildMultipartUpload } from '../attachments/testMultipart.ts';
import type { MultipartFile } from '../attachments/testMultipart.ts';
import { ChatService } from './ChatService.ts';
import { createChatRoutes } from './createChatRoutes.ts';
import { CLEANUP_RETRIES } from './testCleanup.ts';

async function postUpload(app: Hono, botId: string, files: MultipartFile[]): Promise<Response> {
    const upload = await buildMultipartUpload(files);
    const chunks = await upload.body.toArray() as Buffer[];
    const bytes = Buffer.concat(chunks);

    return app.request(`/api/bots/${botId}/attachments`, {
        method: 'POST',
        headers: { 'content-type': upload.contentType },
        body: bytes,
    });
}

function describeEvent(event: ChatEvent): string {
    if (event.type === 'turn') {
        return `turn:${String(event.isRunning)}`;
    }

    if (event.type === 'textDelta') {
        return `delta:${event.text}`;
    }

    if (event.type === 'toolStarted') {
        return `toolStarted:${event.toolName}`;
    }

    if (event.type === 'webhookUrl') {
        return 'webhookUrl';
    }

    if (event.type === 'personCredentials') {
        return 'personCredentials';
    }

    if (event.type === 'screen') {
        return 'screen';
    }

    if (event.type === 'botDeleted') {
        return 'botDeleted';
    }

    if (event.type === 'messagesRemoved') {
        return 'messagesRemoved';
    }

    return `message:${event.message.role}:${event.message.body.kind}`;
}

// Reads server-sent events until the turn reports it finished, then stops reading.
async function readEventsUntilTurnFinished(response: Response): Promise<ChatEvent[]> {
    const events: ChatEvent[] = [];
    const decoder = new TextDecoder();
    let pendingText = '';

    if (response.body === null) {
        throw new Error('The event stream has no body');
    }

    const chunks = response.body as AsyncIterable<Uint8Array>;

    for await (const chunk of chunks) {
        pendingText += decoder.decode(chunk, { stream: true });

        const frames = pendingText.split('\n\n');

        pendingText = frames.pop() ?? '';

        frames
            .filter(frame => frame.startsWith('data: '))
            .forEach((frame) => {
                events.push(JSON.parse(frame.slice('data: '.length)) as ChatEvent);
            });

        // The first event is the state snapshot sent on connect, so the finish must come after it.
        const lastEvent = events[events.length - 1];
        const isFinished = events.length > 1 && lastEvent?.type === 'turn' && !lastEvent.isRunning;

        if (isFinished) {
            break;
        }
    }

    return events;
}

async function postJson(app: Hono, path: string, payload: unknown): Promise<Response> {
    const response = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    return response;
}

// The first turn runs until a stop aborts it. Its own runner signal is the only way out.
async function* stayOpenUntilAborted(abortSignal: AbortSignal): AsyncGenerator<AgentEvent> {
    await new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => {
            resolve();
        }, { once: true });
    });

    yield { type: 'turn_finished' };
}

// A rejected usage limit that ends the turn, as the runner reports it.
// eslint-disable-next-line @typescript-eslint/require-await
async function* usageLimitEvents(resetsAt: number): AsyncGenerator<AgentEvent> {
    yield { type: 'rate_limit', status: 'rejected', resetsAt };
    yield { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt };
}
// Yields one event, so there is nothing to await. The runner still needs an async iterable.
// eslint-disable-next-line @typescript-eslint/require-await
async function* finishImmediately(): AsyncGenerator<AgentEvent> {
    yield { type: 'turn_finished' };
}

describe('chat routes', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-routes-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    function buildApp(script: ScriptedAgentStep[]): Hono {
        const runner = new FakeAgentRunner(script);
        const chatService = new ChatService({ botStore, messageStore, runner, dataDir });

        // The session check lives in createApp, so these tests call the routes alone.
        return createChatRoutes(chatService);
    }

    it('lists the bots with an empty preview before any message', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await app.request('/api/bots');
        const bots = await response.json() as { id: string; name: string; lastMessagePreview: string }[];

        expect(bots)
            .toEqual([expect.objectContaining({ id: bot.id, name: 'Ana', lastMessagePreview: '' })]);
    });

    it('stores a posted message and returns it with status 201', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'Hi' });
        const savedMessage = await response.json() as ChatMessage;

        expect(response.status)
            .toBe(201);
        expect(savedMessage)
            .toMatchObject({ botId: bot.id, role: 'user', body: { kind: 'text', text: 'Hi' } });

        const listResponse = await app.request(`/api/bots/${bot.id}/messages`);

        expect(await listResponse.json())
            .toEqual([expect.objectContaining({ id: savedMessage.id })]);
    });

    it('answers 400 for an empty text and for invalid JSON', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const emptyResponse = await postJson(app, `/api/bots/${bot.id}/messages`, { text: '   ' });
        const invalidResponse = await app.request(`/api/bots/${bot.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json',
        });

        expect(emptyResponse.status)
            .toBe(400);
        expect(invalidResponse.status)
            .toBe(400);
    });

    it('answers 404 for an unknown bot on every bot route', async () => {
        const app = buildApp([]);
        const listResponse = await app.request('/api/bots/missing/messages');
        const postResponse = await postJson(app, '/api/bots/missing/messages', { text: 'Hi' });
        const stopResponse = await app.request('/api/bots/missing/stop', { method: 'POST' });
        const eventsResponse = await app.request('/api/bots/missing/events');

        expect(listResponse.status)
            .toBe(404);
        expect(postResponse.status)
            .toBe(404);
        expect(stopResponse.status)
            .toBe(404);
        expect(eventsResponse.status)
            .toBe(404);
    });

    it('accepts a message posted while the bot is still answering, and queues it', async () => {
        let turnCount = 0;
        const firstTurnStarted = Promise.withResolvers<boolean>();
        const runner: AgentRunner = {
            runTurn: (request) => {
                turnCount += 1;

                if (turnCount === 1) {
                    firstTurnStarted.resolve(true);

                    return stayOpenUntilAborted(request.abortSignal);
                }

                return finishImmediately();
            },
        };
        const chatService = new ChatService({ botStore, messageStore, runner, dataDir });
        const app = createChatRoutes(chatService);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        let finishedTurns = 0;
        const bothFinished = new Promise<void>((resolve) => {
            chatService.subscribe(bot.id, (event: ChatEvent) => {
                if (event.type === 'turn' && !event.isRunning) {
                    finishedTurns += 1;

                    if (finishedTurns === 1) {
                        resolve();
                    }
                }
            });
        });

        await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'first' });
        await firstTurnStarted.promise;

        const secondResponse = await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'second' });
        const stopResponse = await app.request(`/api/bots/${bot.id}/stop`, { method: 'POST' });

        expect(secondResponse.status)
            .toBe(201);
        expect(stopResponse.status)
            .toBe(204);

        await bothFinished;
    });

    it('tells a reloaded page that the bot is busy while it waits for a usage limit', async () => {
        const resetsAt = Date.now() + 60 * 60 * 1000;
        const runner: AgentRunner = {
            runTurn: () => usageLimitEvents(resetsAt),
        };
        const chatService = new ChatService({ botStore, messageStore, runner, dataDir });
        const app = createChatRoutes(chatService);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const noticeShown = new Promise<void>((resolve) => {
            const unsubscribe = chatService.subscribe(bot.id, (event: ChatEvent) => {
                if (event.type === 'message' && event.message.role === 'system') {
                    unsubscribe();
                    resolve();
                }
            });
        });

        await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'first' });
        await noticeShown;

        // The notice comes before the turn settles. The page reloads after it has.
        await vi.waitFor(() => {
            expect(chatService.isTurnRunning(bot.id))
                .toBe(false);
        });

        const eventsResponse = await app.request(`/api/bots/${bot.id}/events`);
        const decoder = new TextDecoder();
        const chunks = eventsResponse.body as AsyncIterable<Uint8Array>;
        let firstText = '';

        for await (const chunk of chunks) {
            firstText = decoder.decode(chunk);

            break;
        }

        chatService.dispose();

        expect(firstText)
            .toContain('"isRunning":true');
    });
    it('streams the events of a turn to a connected client in order', async () => {
        const app = buildApp([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text', text: 'Hello' } },
            { event: { type: 'turn_finished' } },
        ]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const eventsResponse = await app.request(`/api/bots/${bot.id}/events`);
        const receivedEventsPromise = readEventsUntilTurnFinished(eventsResponse);

        await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'Hi' });

        const receivedEvents = await receivedEventsPromise;

        expect(receivedEvents.map(describeEvent))
            .toEqual(['turn:false', 'turn:true', 'message:user:text', 'message:assistant:text', 'turn:false']);
    });

    it('answers HEAD on the event stream without subscribing', async () => {
        const chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const routes = createChatRoutes(chatService);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const subscribeSpy = vi.spyOn(chatService, 'subscribe');
        const response = await routes.request(`/api/bots/${bot.id}/events`, { method: 'HEAD' });

        expect(response.status)
            .toBe(200);
        expect(subscribeSpy)
            .not.toHaveBeenCalled();
    });

    it('does not subscribe for a request that was already aborted', async () => {
        const chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const routes = createChatRoutes(chatService);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const subscribeSpy = vi.spyOn(chatService, 'subscribe');
        const abortController = new AbortController();

        abortController.abort();
        await routes.request(`/api/bots/${bot.id}/events`, { signal: abortController.signal });

        expect(subscribeSpy)
            .not.toHaveBeenCalled();
    });

    it('sends a heartbeat comment on an idle event stream', async () => {
        const chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const routes = createChatRoutes(chatService, { heartbeatIntervalMs: 5 });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await routes.request(`/api/bots/${bot.id}/events`);
        const decoder = new TextDecoder();
        const chunks = response.body as AsyncIterable<Uint8Array>;
        let receivedText = '';

        for await (const chunk of chunks) {
            receivedText += decoder.decode(chunk, { stream: true });

            if (receivedText.includes(': heartbeat')) {
                break;
            }
        }

        expect(receivedText)
            .toContain(': heartbeat');
    });

    it('stores an uploaded file in the bot upload folder and answers 201 with its summary', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await postUpload(app, bot.id, [{ name: 'notes.txt', bytes: Buffer.from('hello') }]);

        expect(response.status)
            .toBe(201);
        expect(await response.json())
            .toEqual([{ name: 'notes.txt', mimeType: 'application/octet-stream', sizeBytes: 5 }]);
        expect(await readdir(join(dataDir, 'uploads', bot.id)))
            .toHaveLength(1);
    });

    it('answers 413 when a file is over CLOUDBOT_MAX_UPLOAD_MB and keeps nothing', async () => {
        const chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });
        const app = createChatRoutes(chatService, { maxUploadBytes: 4 });
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await postUpload(app, bot.id, [{ name: 'big.txt', bytes: Buffer.alloc(100) }]);

        expect(response.status)
            .toBe(413);
        await expect(readdir(join(dataDir, 'uploads', bot.id)))
            .rejects.toThrow();
    });

    it('answers 400 when the body is not multipart form data', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const response = await app.request(`/api/bots/${bot.id}/attachments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });

        expect(response.status)
            .toBe(400);
    });

    it('answers 404 for an upload to an unknown bot', async () => {
        const app = buildApp([]);
        const response = await postUpload(app, 'missing', [{ name: 'notes.txt', bytes: Buffer.from('hello') }]);

        expect(response.status)
            .toBe(404);
    });

    it('answers 400 when one request carries more than 10 files', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const elevenFiles = Array.from({ length: 11 }, (_value, index) => ({ name: `file-${String(index)}.txt`, bytes: Buffer.from('x') }));
        const response = await postUpload(app, bot.id, elevenFiles);

        expect(response.status)
            .toBe(400);
    });

    it('answers 413 when the next message already holds 10 files', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const tenFiles = Array.from({ length: 10 }, (_value, index) => ({ name: `file-${String(index)}.txt`, bytes: Buffer.from('x') }));
        const firstResponse = await postUpload(app, bot.id, tenFiles);
        const secondResponse = await postUpload(app, bot.id, [{ name: 'extra.txt', bytes: Buffer.from('x') }]);

        expect(firstResponse.status)
            .toBe(201);
        expect(secondResponse.status)
            .toBe(413);
    });

    it('answers 409 when files are uploaded while the bot is still answering, and keeps nothing', async () => {
        const app = buildApp([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'first' });

        const uploadResponse = await postUpload(app, bot.id, [{ name: 'late.txt', bytes: Buffer.from('x') }]);
        const stopResponse = await app.request(`/api/bots/${bot.id}/stop`, { method: 'POST' });

        expect(uploadResponse.status)
            .toBe(409);
        expect(await uploadResponse.json())
            .toEqual({ error: 'Wait until the reply finishes.' });
        expect(stopResponse.status)
            .toBe(204);
    });

    it('lists the waiting files, removes one with 204, and answers 404 for an unknown file or bot', async () => {
        const app = buildApp([]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await postUpload(app, bot.id, [{ name: 'notes.txt', bytes: Buffer.from('hello') }]);

        const listResponse = await app.request(`/api/bots/${bot.id}/uploads`);
        const uploads = await listResponse.json() as { id: string; name: string; sizeBytes: number }[];

        expect(uploads.map(upload => upload.name))
            .toEqual(['notes.txt']);

        const removeResponse = await app.request(`/api/bots/${bot.id}/uploads/${uploads[0]?.id ?? ''}`, { method: 'DELETE' });
        const unknownFileResponse = await app.request(`/api/bots/${bot.id}/uploads/unknown`, { method: 'DELETE' });
        const unknownBotResponse = await app.request('/api/bots/missing/uploads');

        expect(removeResponse.status)
            .toBe(204);
        expect(unknownFileResponse.status)
            .toBe(404);
        expect(unknownBotResponse.status)
            .toBe(404);
    });
});

describe('GET /api/bots/:id/messages paging', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-paging-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    function buildApp(): Hono {
        const chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir });

        return createChatRoutes(chatService);
    }

    // Writes one at a time, so the sequences follow the numbers in the text.
    async function seedMessages(botId: string, count: number): Promise<void> {
        await Array.from({ length: count })
            .reduce<Promise<void>>(async (previousWrite, _unused, index) => {
                await previousWrite;
                await messageStore.add({
                    botId,
                    role: 'user',
                    kind: 'text',
                    content: { kind: 'text', text: `message ${String(index + 1)}` },
                });
            }, Promise.resolve());
    }

    async function fetchStatus(app: Hono, path: string): Promise<number> {
        const response = await app.request(path);

        return response.status;
    }

    async function fetchTexts(app: Hono, path: string): Promise<string[]> {
        const response = await app.request(path);
        const messages = await response.json() as ChatMessage[];

        return messages.map(message => (message.body.kind === 'text' ? message.body.text : ''));
    }

    it('answers the newest 50 messages, oldest first, when no page is asked for', async () => {
        const app = buildApp();
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedMessages(bot.id, 60);

        const texts = await fetchTexts(app, `/api/bots/${bot.id}/messages`);

        expect(texts)
            .toEqual(Array.from({ length: 50 }, (_unused, index) => `message ${String(index + 11)}`));
    });

    it('answers a middle page before the given sequence', async () => {
        const app = buildApp();
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedMessages(bot.id, 60);

        const storedMessages = await messageStore.listByBot(bot.id, { limit: 200 });
        const sequenceOfMessage31 = storedMessages[30]?.sequence;
        const texts = await fetchTexts(app, `/api/bots/${bot.id}/messages?before=${String(sequenceOfMessage31)}&limit=10`);

        expect(texts)
            .toEqual(Array.from({ length: 10 }, (_unused, index) => `message ${String(index + 21)}`));
    });

    it('answers the last page with only the messages that remain', async () => {
        const app = buildApp();
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedMessages(bot.id, 60);

        const storedMessages = await messageStore.listByBot(bot.id, { limit: 200 });
        const sequenceOfMessage3 = storedMessages[2]?.sequence;
        const texts = await fetchTexts(app, `/api/bots/${bot.id}/messages?before=${String(sequenceOfMessage3)}&limit=10`);

        expect(texts)
            .toEqual(['message 1', 'message 2']);
    });

    it('caps the page size at 200 when a larger limit is asked for', async () => {
        const app = buildApp();
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedMessages(bot.id, 205);

        const texts = await fetchTexts(app, `/api/bots/${bot.id}/messages?limit=500`);

        expect(texts)
            .toHaveLength(200);
    });

    it('answers 400 for a cursor or limit that is not a whole number of 1 or more', async () => {
        const app = buildApp();
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });
        const badQueries = ['before=abc', 'before=0', 'before=-1', 'before=1.5', 'limit=0', 'limit=abc', 'limit=-3'];
        const statusPromises = badQueries.map(query => fetchStatus(app, `/api/bots/${bot.id}/messages?${query}`));
        const statuses = await Promise.all(statusPromises);

        expect(statuses)
            .toEqual(badQueries.map(() => 400));
    });
});

describe('shared files', () => {
    let dataDir: string;
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let messageStore: MessageStore;
    let chatService: ChatService;
    let app: Hono;

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'cloudbot-shared-'));
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        messageStore = new MessageStore(opened.db);
        chatService = new ChatService({ botStore, messageStore, runner: new FakeAgentRunner([]), dataDir, maxShareBytes: 100 });
        app = createChatRoutes(chatService);
    });

    afterEach(async () => {
        opened.close();
        await rm(dataDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES });
    });

    async function seedWorkspaceFile(botId: string, name: string, content: string): Promise<void> {
        const workspace = chatService.workspaceFor(botId);

        await mkdir(workspace, { recursive: true });
        await writeFile(join(workspace, name), content);
    }

    it('posts a file message and downloads the copy as an attachment', async () => {
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });
        const events: ChatEvent[] = [];

        chatService.subscribe(bot.id, event => events.push(event));
        await seedWorkspaceFile(bot.id, 'sales report.csv', 'a,b\n');

        const shared = await chatService.shareFile(bot.id, 'sales report.csv');
        const messages = await chatService.listMessages(bot.id) ?? [];
        const fileMessage = messages[0];

        expect(shared)
            .toEqual({ name: 'sales report.csv', sizeBytes: 4 });
        expect(fileMessage?.body.kind)
            .toBe('file');
        expect(events.map(describeEvent))
            .toEqual(['message:assistant:file']);

        const response = await app.request(`/api/bots/${bot.id}/messages/${fileMessage?.id ?? ''}/file`);

        expect(response.status)
            .toBe(200);
        expect(response.headers.get('content-disposition'))
            .toBe('attachment; filename="sales report.csv"; filename*=UTF-8\'\'sales%20report.csv');
        expect(response.headers.get('content-type'))
            .toBe('text/csv');
        expect(response.headers.get('x-content-type-options'))
            .toBe('nosniff');
        expect(await response.text())
            .toBe('a,b\n');
    });

    it('encodes quotes and brackets in the download name', async () => {
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedWorkspaceFile(bot.id, 'it\'s (1).txt', 'x');
        await chatService.shareFile(bot.id, 'it\'s (1).txt');

        const fileMessage = (await chatService.listMessages(bot.id) ?? []).find(message => message.body.kind === 'file');
        const response = await app.request(`/api/bots/${bot.id}/messages/${fileMessage?.id ?? ''}/file`);

        expect(response.headers.get('content-disposition'))
            .toBe('attachment; filename="it\'s (1).txt"; filename*=UTF-8\'\'it%27s%20%281%29.txt');
    });

    it('refuses an oversized file and posts no message', async () => {
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedWorkspaceFile(bot.id, 'big.bin', 'x'.repeat(101));

        await expect(chatService.shareFile(bot.id, 'big.bin'))
            .rejects
            .toThrow('larger than');
        expect(await chatService.listMessages(bot.id))
            .toEqual([]);
    });

    it('answers 404 for a text message, an unknown message and another bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });
        const other = await botStore.create({ name: 'Bia', title: '', description: '' });
        const textMessage = await messageStore.add({ botId: bot.id, role: 'user', kind: 'text', content: { kind: 'text', text: 'hi' } });

        await seedWorkspaceFile(bot.id, 'a.txt', 'x');
        await chatService.shareFile(bot.id, 'a.txt');

        const fileMessage = (await chatService.listMessages(bot.id) ?? []).find(message => message.body.kind === 'file');
        const urls = [
            `/api/bots/${bot.id}/messages/${textMessage.id}/file`,
            `/api/bots/${bot.id}/messages/nope/file`,
            `/api/bots/${other.id}/messages/${fileMessage?.id ?? ''}/file`,
        ];
        const statuses = await Promise.all(urls.map(async url => (await app.request(url)).status));

        expect(statuses)
            .toEqual([404, 404, 404]);
    });

    it('answers 404 when the stored copy is gone', async () => {
        const bot = await botStore.create({ name: 'Ana', title: '', description: '' });

        await seedWorkspaceFile(bot.id, 'a.txt', 'x');
        await chatService.shareFile(bot.id, 'a.txt');
        await rm(chatService.shareDirFor(bot.id), { recursive: true });

        const fileMessage = (await chatService.listMessages(bot.id) ?? []).find(message => message.body.kind === 'file');
        const response = await app.request(`/api/bots/${bot.id}/messages/${fileMessage?.id ?? ''}/file`);

        expect(response.status)
            .toBe(404);
    });
});
