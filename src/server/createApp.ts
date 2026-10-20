import { existsSync } from 'node:fs';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';

interface HealthResponse {
    status: 'ok';
    version: string;
}

interface AppOptions {
    version: string;
    webRoot?: string;
}

const DEFAULT_WEB_ROOT = 'dist/web';
const API_PREFIX = '/api/';

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

    app.get('/api/health', (context) => {
        const body: HealthResponse = { status: 'ok', version: options.version };

        return context.json(body);
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
