import { Hono } from 'hono';

import type { AppSignInStart, ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { ChatMessage } from '../../shared/chatTypes.ts';
import { BotDeletingError } from '../bots/BotDeletingError.ts';
import type { ChatService } from '../chat/ChatService.ts';
import { parseAppUrl } from './appAddress.ts';
import type { AppOAuth } from './AppOAuth.ts';
import type { ConnectedApps } from './ConnectedApps.ts';

interface AppErrorResponse {
    error: string;
}

// These routes sit behind the session check so only the owner can inspect or change connected apps.
interface AppRoutesOptions {
    connectedApps: Pick<ConnectedApps, 'list' | 'remove'>;
    chatService?: Pick<ChatService, 'sendMessage'> | undefined;
    // The sign-in through the server's own page, and the address the server sends the owner back to.
    signIn?: AppSignInOptions | undefined;
}

interface AppSignInOptions {
    oauth: Pick<AppOAuth, 'start'>;
    redirectUri: string;
    hasBot: (botId: string) => Promise<boolean>;
}

const APP_NOT_FOUND: AppErrorResponse = { error: 'No connected server has this id.' };
const BOT_NOT_FOUND: AppErrorResponse = { error: 'No bot has this id.' };
const BOT_DELETING: AppErrorResponse = { error: 'This bot is being deleted.' };
const INVALID_CONNECTION: AppErrorResponse = { error: 'Send a valid app name and a full http or https address without a token.' };
const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

interface AppConnectionRequest {
    botId: string;
    name: string;
    url: string;
}

function readConnectionRequest(requestBody: unknown): AppConnectionRequest | undefined {
    if (typeof requestBody !== 'object' || requestBody === null) {
        return undefined;
    }

    const botIdValue: unknown = Reflect.get(requestBody, 'botId');
    const nameValue: unknown = Reflect.get(requestBody, 'name');
    const urlValue: unknown = Reflect.get(requestBody, 'url');

    if (typeof botIdValue !== 'string' || typeof nameValue !== 'string' || typeof urlValue !== 'string') {
        return undefined;
    }

    const botId = botIdValue.trim();
    const name = nameValue.trim();
    const url = urlValue.trim();

    if (botId.length === 0 || !APP_NAME_PATTERN.test(name)) {
        return undefined;
    }

    try {
        const parsedUrl = parseAppUrl(url);

        return { botId, name, url: parsedUrl.href };
    } catch {
        return undefined;
    }
}

function createConnectionMessage(name: string, url: string): string {
    return `Please connect the app named "${name}" at ${url} with app_connect, following its approval and sign-in flow.`;
}

function createAppRoutes(options: AppRoutesOptions): Hono {
    const routes = new Hono();
    const chatService = options.chatService;

    routes.get('/api/apps', async (context) => {
        const apps: ConnectedAppSummary[] = await options.connectedApps.list();

        return context.json(apps);
    });

    const signIn = options.signIn;

    if (signIn !== undefined) {
        routes.post('/api/apps/oauth/start', async (context) => {
            let requestBody: unknown;

            try {
                requestBody = await context.req.json();
            } catch {
                requestBody = undefined;
            }

            const request = readConnectionRequest(requestBody);

            if (request === undefined) {
                return context.json(INVALID_CONNECTION, 400);
            }

            const isKnownBot = await signIn.hasBot(request.botId);

            if (!isKnownBot) {
                return context.json(BOT_NOT_FOUND, 404);
            }

            const start: AppSignInStart = await signIn.oauth.start(request.botId, request.name, request.url, signIn.redirectUri);

            return context.json(start);
        });
    }

    if (chatService !== undefined) {
        routes.post('/api/apps/connect', async (context) => {
            let requestBody: unknown;

            try {
                requestBody = await context.req.json();
            } catch {
                requestBody = undefined;
            }

            const request = readConnectionRequest(requestBody);

            if (request === undefined) {
                return context.json(INVALID_CONNECTION, 400);
            }

            const messageText = createConnectionMessage(request.name, request.url);
            let message: ChatMessage | undefined;

            try {
                message = await chatService.sendMessage(request.botId, messageText);
            } catch (error: unknown) {
                if (error instanceof BotDeletingError) {
                    return context.json(BOT_DELETING, 409);
                }

                throw error;
            }

            if (message === undefined) {
                return context.json(BOT_NOT_FOUND, 404);
            }

            return context.json(message, 201);
        });
    }

    routes.delete('/api/apps/:id', async (context) => {
        const appId = context.req.param('id');
        const isRemoved = await options.connectedApps.remove(appId);

        if (!isRemoved) {
            return context.json(APP_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createAppRoutes };
export type { AppRoutesOptions, AppSignInOptions };
