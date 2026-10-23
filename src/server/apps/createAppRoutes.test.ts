import { describe, expect, it } from 'vitest';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { ChatMessage } from '../../shared/chatTypes.ts';
import { createAppRoutes } from './createAppRoutes.ts';

const APP: ConnectedAppSummary = { id: 'app-1', name: 'linear', url: 'https://mcp.linear.app/mcp', status: 'connected', toolCount: 4 };

interface SentChatMessage {
    botId: string;
    text: string;
}

function createChatMessage(text: string): ChatMessage {
    return {
        id: 'message-1',
        botId: 'bot-1',
        role: 'user',
        createdAt: 1,
        sequence: 1,
        body: { kind: 'text', text },
    };
}

async function postJson(app: ReturnType<typeof createAppRoutes>, path: string, value: unknown): Promise<Response> {
    const response = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
    });

    return response;
}

describe('app routes', () => {
    it('lists the connected servers without tokens', async () => {
        const routes = createAppRoutes({ connectedApps: { list: () => Promise.resolve([APP]), remove: () => Promise.resolve(false) } });
        const response = await routes.request('/api/apps');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual([APP]);
    });

    it('removes a server by id, and answers 404 for an unknown id', async () => {
        const removed: string[] = [];
        const routes = createAppRoutes({
            connectedApps: {
                list: () => Promise.resolve([]),
                remove: (id) => {
                    removed.push(id);

                    return Promise.resolve(id === 'app-1');
                },
            },
        });

        expect((await routes.request('/api/apps/app-1', { method: 'DELETE' })).status)
            .toBe(204);
        expect((await routes.request('/api/apps/app-9', { method: 'DELETE' })).status)
            .toBe(404);
        expect(removed)
            .toEqual(['app-1', 'app-9']);
    });

    it('starts the existing connection flow in the selected bot chat', async () => {
        const sentMessages: SentChatMessage[] = [];
        const connectionText = 'Please connect the app named "linear" at https://mcp.linear.app/mcp with app_connect, following its approval and sign-in flow.';
        const connectedMessage = createChatMessage(connectionText);
        const routes = createAppRoutes({
            connectedApps: { list: () => Promise.resolve([]), remove: () => Promise.resolve(false) },
            chatService: {
                sendMessage: (botId, text) => {
                    sentMessages.push({ botId, text });

                    return Promise.resolve(connectedMessage);
                },
            },
        });

        const response = await postJson(routes, '/api/apps/connect', {
            botId: 'bot-1',
            name: 'linear',
            url: 'https://mcp.linear.app/mcp',
        });
        const responseBody: unknown = await response.json();

        expect(response.status)
            .toBe(201);
        expect(responseBody)
            .toEqual(connectedMessage);
        expect(sentMessages)
            .toEqual([{ botId: 'bot-1', text: connectionText }]);
    });

    it('refuses an invalid address before sending a chat message', async () => {
        const sentMessages: SentChatMessage[] = [];
        const routes = createAppRoutes({
            connectedApps: { list: () => Promise.resolve([]), remove: () => Promise.resolve(false) },
            chatService: {
                sendMessage: (botId, text) => {
                    sentMessages.push({ botId, text });

                    return Promise.resolve(createChatMessage(text));
                },
            },
        });

        const response = await postJson(routes, '/api/apps/connect', {
            botId: 'bot-1',
            name: 'linear',
            url: 'https://user:secret@mcp.linear.app/mcp?token=secret',
        });

        expect(response.status)
            .toBe(400);
        expect(sentMessages)
            .toEqual([]);
    });

    it('answers 404 when the selected bot does not exist', async () => {
        const routes = createAppRoutes({
            connectedApps: { list: () => Promise.resolve([]), remove: () => Promise.resolve(false) },
            chatService: { sendMessage: () => Promise.resolve(undefined) },
        });

        const response = await postJson(routes, '/api/apps/connect', {
            botId: 'missing-bot',
            name: 'linear',
            url: 'https://mcp.linear.app/mcp',
        });

        expect(response.status)
            .toBe(404);
    });
});
