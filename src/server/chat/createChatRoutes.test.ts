import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatEvent, ChatMessage } from '../../shared/chatTypes.ts';
import { FakeAgentRunner } from '../agent/FakeAgentRunner.ts';
import type { ScriptedAgentStep } from '../agent/FakeAgentRunner.ts';
import { BotStore } from '../store/BotStore.ts';
import { MessageStore } from '../store/MessageStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { ChatService } from './ChatService.ts';
import { createChatRoutes } from './createChatRoutes.ts';

function describeEvent(event: ChatEvent): string {
    if (event.type === 'turn') {
        return `turn:${String(event.isRunning)}`;
    }

    if (event.type === 'textDelta') {
        return `delta:${event.text}`;
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
        await rm(dataDir, { recursive: true, force: true });
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

    it('answers 409 when a message is posted while the bot is still answering', async () => {
        const app = buildApp([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'first' });

        const secondResponse = await postJson(app, `/api/bots/${bot.id}/messages`, { text: 'second' });
        const stopResponse = await app.request(`/api/bots/${bot.id}/stop`, { method: 'POST' });

        expect(secondResponse.status)
            .toBe(409);
        expect(stopResponse.status)
            .toBe(204);
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
});
