import { Hono } from 'hono';

import type { ActionLog } from './ActionLog.ts';

interface ActionLogRoutesOptions {
    actionLog: Pick<ActionLog, 'read'>;
}

const MAX_ENTRIES = 300;

// The owner's view of the log, behind the session check. It holds only names and outcomes.
function createActionLogRoutes(options: ActionLogRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/action-log', (context) => {
        const botId = context.req.query('botId');
        const decision = context.req.query('decision');
        const entries = options.actionLog.read(MAX_ENTRIES, botId, decision);

        return context.json(entries);
    });

    return routes;
}

export { MAX_ENTRIES, createActionLogRoutes };
