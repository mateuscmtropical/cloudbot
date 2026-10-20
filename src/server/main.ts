import { serve } from '@hono/node-server';

import { createApp } from './createApp.ts';

const DEFAULT_PORT = 3000;

const portText = process.env.PORT ?? '';
const parsedPort = Number.parseInt(portText, 10);
const port = Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;
const version = process.env.CLOUDBOT_VERSION ?? 'dev';
const app = createApp({ version });

serve({ fetch: app.fetch, port }, (address) => {
    console.log(`CloudBot is listening on http://localhost:${String(address.port)}`);
});
