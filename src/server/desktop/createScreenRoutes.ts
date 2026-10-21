import { Hono } from 'hono';

import type { ScreenHolder, ScreenHolderName } from './ScreenHolder.ts';

interface ScreenStateResponse {
    holder: ScreenHolderName;
}

// The routes sit behind the session check. The bot has no tool to take the screen back.
function createScreenRoutes(screen: ScreenHolder): Hono {
    const routes = new Hono();

    routes.get('/api/desktop/screen', (context) => {
        const body: ScreenStateResponse = { holder: screen.holder };

        return context.json(body);
    });

    // The owner takes the screen. The bot stops acting on it.
    routes.post('/api/desktop/screen/take', (context) => {
        screen.giveToPerson();

        const body: ScreenStateResponse = { holder: screen.holder };

        return context.json(body);
    });

    // The owner gives the screen back. The bot does not start a turn on its own.
    routes.post('/api/desktop/screen/release', (context) => {
        screen.giveToBot();

        const body: ScreenStateResponse = { holder: screen.holder };

        return context.json(body);
    });

    return routes;
}

export { createScreenRoutes };
export type { ScreenStateResponse };
