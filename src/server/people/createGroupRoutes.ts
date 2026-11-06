import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { PeopleErrorResponse, SentBotResult } from '../../shared/peopleTypes.ts';
import type { HubClient } from './HubClient.ts';
import { PeopleAdminError } from './PeopleAdmin.ts';

type GroupsAdmin = Pick<HubClient, 'listGroups' | 'addGroup' | 'setGroupMember' | 'sendBotToGroup'>;

interface GroupRoutesOptions {
    groupsAdmin: GroupsAdmin;
    exportBot: (botId: string) => Promise<string>;
    // Gives "deleted", or the reason the bot stayed here, which goes to the owner.
    removeBot: (botId: string) => Promise<string>;
}

interface UnknownRecord {
    [key: string]: unknown;
}

const SEND_MODES = ['copy', 'move'] as const;

function readField(body: unknown, field: string): string | undefined {
    const value = typeof body === 'object' && body !== null ? (body as UnknownRecord)[field] : undefined;

    return typeof value === 'string' ? value : undefined;
}

function fail(context: Context, error: unknown): Response {
    if (!(error instanceof PeopleAdminError)) {
        throw error;
    }

    const body: PeopleErrorResponse = { error: error.message };

    return context.json(body, error.status as ContentfulStatusCode);
}

function refuse(context: Context, message: string): Response {
    const body: PeopleErrorResponse = { error: message };

    return context.json(body, 400);
}

async function readBody(context: Context): Promise<unknown> {
    return context.req.json()
        .catch(() => undefined);
}

// Copy leaves the bot here and makes one in the group. Move also deletes it here once the group has it.
async function sendBot(context: Context, options: GroupRoutesOptions): Promise<Response> {
    const body = await readBody(context);
    const botId = readField(body, 'botId');
    const modeText = readField(body, 'mode');
    const mode = SEND_MODES.find(candidate => candidate === modeText);

    if (botId === undefined || mode === undefined) {
        return refuse(context, 'Send a botId and the mode copy or move.');
    }

    let template: string;

    try {
        template = await options.exportBot(botId);
    } catch (error: unknown) {
        return refuse(context, error instanceof Error ? error.message : 'This bot cannot be copied.');
    }

    try {
        const name = await options.groupsAdmin.sendBotToGroup(context.req.param('name') ?? '', template);
        const removal = mode === 'move' ? await options.removeBot(botId) : undefined;
        const result: SentBotResult = removal === undefined || removal === 'deleted'
            ? { name, isMoved: removal === 'deleted' }
            : { name, isMoved: false, problem: `The group has a copy, but it stayed here too. ${removal}` };

        return context.json(result, 201);
    } catch (error: unknown) {
        return fail(context, error);
    }
}

// Only on the owner's instance. The hub checks the owner's secret on every call too.
function createGroupRoutes(options: GroupRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/groups', async (context) => {
        try {
            const groups = await options.groupsAdmin.listGroups();

            return context.json(groups);
        } catch (error: unknown) {
            return fail(context, error);
        }
    });

    routes.post('/api/groups', async (context) => {
        const body = await readBody(context);
        const name = readField(body, 'name') ?? '';
        const problem = checkPersonName(name);

        if (problem !== undefined) {
            return refuse(context, problem);
        }

        try {
            const group = await options.groupsAdmin.addGroup(name);

            return context.json(group, 201);
        } catch (error: unknown) {
            return fail(context, error);
        }
    });

    routes.put('/api/groups/:name/members/:person', async (context) => {
        const body = await readBody(context);
        const role = readField(body, 'role');

        if (role !== 'admin' && role !== 'member') {
            return refuse(context, 'The role must be admin or member.');
        }

        const groupName = context.req.param('name');
        const personName = context.req.param('person');

        try {
            const group = await options.groupsAdmin.setGroupMember(groupName, personName, role);

            return context.json(group);
        } catch (error: unknown) {
            return fail(context, error);
        }
    });

    routes.post('/api/groups/:name/bots', context => sendBot(context, options));

    return routes;
}

export { createGroupRoutes };
export type { GroupRoutesOptions, GroupsAdmin };
