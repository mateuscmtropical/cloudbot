import { existsSync } from 'node:fs';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';

import { requireSession, SESSION_COOKIE_NAME } from './access/requireSession.ts';
import type { AccessErrorResponse } from './access/requireSession.ts';
import type { SetupAccess } from './access/SetupAccess.ts';

import { createChatRoutes } from './chat/createChatRoutes.ts';
import type { ChatService } from './chat/ChatService.ts';
import { createScreenRoutes } from './desktop/createScreenRoutes.ts';
import type { ScreenHolder } from './desktop/ScreenHolder.ts';
import { createRuleRoutes } from './rules/createRuleRoutes.ts';
import { createRoutineRoutes } from './routines/createRoutineRoutes.ts';
import type { RoutineStore } from './store/RoutineStore.ts';
import type { RuleStore } from './store/RuleStore.ts';

interface HealthResponse {
    status: 'ok';
    version: string;
}

interface AppOptions {
    version: string;
    access: SetupAccess;
    webRoot?: string;
    chatService?: ChatService;
    ruleStore?: RuleStore;
    routineStore?: RoutineStore;
    screen?: ScreenHolder;
}

const DEFAULT_WEB_ROOT = 'dist/web';
const API_PREFIX = '/api/';
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
} as const;

function skipApiRoutes(serve: MiddlewareHandler): MiddlewareHandler {
    return (context, next) => {
        if (context.req.path.startsWith(API_PREFIX)) {
            return next();
        }

        return serve(context, next);
    };
}

function createApp(options: AppOptions): Hono {
    const app = new Hono();
    const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;

    // Health is registered before the session check, so it answers without a cookie.
    app.get('/api/health', (context) => {
        const body: HealthResponse = { status: 'ok', version: options.version };

        return context.json(body);
    });

    const sessionCheck = requireSession(options.access);

    app.use('/api/*', sessionCheck);

    // Chat routes sit behind the session check. The web fallback would otherwise answer them.
    if (options.chatService !== undefined) {
        const chatRoutes = createChatRoutes(options.chatService);

        app.route('/', chatRoutes);
    }

    if (options.chatService !== undefined && options.ruleStore !== undefined) {
        const chatService = options.chatService;
        const ruleRoutes = createRuleRoutes({ ruleStore: options.ruleStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', ruleRoutes);
    }

    if (options.chatService !== undefined && options.routineStore !== undefined) {
        const chatService = options.chatService;
        const routineRoutes = createRoutineRoutes({ routineStore: options.routineStore, hasBot: botId => chatService.hasBot(botId) });

        app.route('/', routineRoutes);
    }

    if (options.screen !== undefined) {
        const screenRoutes = createScreenRoutes(options.screen);

        app.route('/', screenRoutes);
    }

    app.get('/setup', async (context) => {
        const setupCode = context.req.query('code') ?? '';
        const sessionToken = await options.access.redeemSetupCode(setupCode);

        if (sessionToken === undefined) {
            const body: AccessErrorResponse = { error: 'This setup link is not valid. Ask the server for a new one.' };

            return context.json(body, 401);
        }

        setCookie(context, SESSION_COOKIE_NAME, sessionToken, SESSION_COOKIE_OPTIONS);

        return context.redirect('/');
    });

    // The web app is optional. Without a build the server only has the API.
    if (existsSync(webRoot)) {
        const serveFile = serveStatic({ root: webRoot });
        const serveIndex = serveStatic({ root: webRoot, path: 'index.html' });

        const serveFileUnlessApi = skipApiRoutes(serveFile);
        const serveIndexUnlessApi = skipApiRoutes(serveIndex);

        app.get('*', serveFileUnlessApi);
        // Unknown paths get index.html so the client-side router can take over.
        app.get('*', serveIndexUnlessApi);
    }

    return app;
}

export { createApp };
export type { AppOptions, HealthResponse };
