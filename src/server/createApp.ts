import { Hono } from 'hono';

interface HealthResponse {
    status: 'ok';
    version: string;
}

interface AppOptions {
    version: string;
}

function createApp(options: AppOptions): Hono {
    const app = new Hono();

    app.get('/api/health', (context) => {
        const body: HealthResponse = { status: 'ok', version: options.version };

        return context.json(body);
    });

    return app;
}

export { createApp };
export type { AppOptions, HealthResponse };
