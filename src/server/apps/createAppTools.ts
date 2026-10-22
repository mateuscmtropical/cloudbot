import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { ConnectOutcome, ConnectedApps } from './ConnectedApps.ts';

interface TextContent {
    type: 'text';
    text: string;
}

interface AppToolResult {
    [key: string]: unknown;
    content: TextContent[];
    isError?: boolean;
}

type AppToolOperations = Pick<ConnectedApps, 'connect' | 'list' | 'remove'>;

const CONNECT_TOOL_NAME = 'app_connect';
const LIST_TOOL_NAME = 'app_list';
const REMOVE_TOOL_NAME = 'app_remove';
const APP_TOOL_FULL_NAMES = [CONNECT_TOOL_NAME, LIST_TOOL_NAME, REMOVE_TOOL_NAME]
    .map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);
const MAX_NAME_LENGTH = 31;
const MAX_URL_LENGTH = 2048;
const MAX_SECRET_NAME_LENGTH = 32;

const CONNECT_DESCRIPTION = 'Connect a remote MCP server by its http or https address, so its tools become available to you. The owner must approve this first. Give a short NAME in lowercase letters. If the server needs a token, ask for it first with request_secret, on the server\'s site, and then pass that secret name as tokenSecret. You never see the token.';
const LIST_DESCRIPTION = 'List the remote MCP servers the owner connected, with their ids, status and tool count.';
const REMOVE_DESCRIPTION = 'Remove a connected remote MCP server by id. Its tools stop being available, and its token is deleted from the vault.';

const CONNECT_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_NAME_LENGTH),
    url: z.string()
        .trim()
        .min(1)
        .max(MAX_URL_LENGTH),
    tokenSecret: z.string()
        .trim()
        .min(1)
        .max(MAX_SECRET_NAME_LENGTH)
        .optional(),
};
const LIST_SHAPE = {};
const REMOVE_SHAPE = {
    id: z.string()
        .min(1),
};

function textResult(text: string, isError = false): AppToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// The reply to the bot for each outcome. It says what to do next, and never repeats a token.
function describeOutcome(outcome: ConnectOutcome): AppToolResult {
    if (outcome.outcome === 'connected') {
        return textResult(`Connected ${outcome.name}. It has ${String(outcome.toolCount)} tools, named mcp__${outcome.name}__<tool>.`);
    }

    if (outcome.outcome === 'needs_token') {
        return textResult(`${outcome.name} needs a token. Ask the owner for it with request_secret, for the site ${outcome.origin}, then call app_connect again with tokenSecret set to that secret name.`);
    }

    return textResult(outcome.problem, true);
}

function describeSummary(app: ConnectedAppSummary): string {
    const problemText = app.problem === undefined ? '' : `, ${app.problem}`;

    return `- ${app.id}: ${app.name}, ${app.url}, ${app.status}, ${String(app.toolCount)} tools${problemText}`;
}

function createAppTools(operations: AppToolOperations, botId: string): CloudbotTool[] {
    const connectTool = tool(
        CONNECT_TOOL_NAME,
        CONNECT_DESCRIPTION,
        CONNECT_SHAPE,
        async (args): Promise<AppToolResult> => {
            const outcome = await operations.connect(botId, {
                name: args.name,
                url: args.url,
                tokenSecret: args.tokenSecret,
            });

            return describeOutcome(outcome);
        },
    );
    const listTool = tool(
        LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<AppToolResult> => {
            const apps = await operations.list();

            if (apps.length === 0) {
                return textResult('No remote servers are connected.');
            }

            const lines = apps.map(describeSummary);

            const listText = lines.join('\n');

            return textResult(listText);
        },
    );
    const removeTool = tool(
        REMOVE_TOOL_NAME,
        REMOVE_DESCRIPTION,
        REMOVE_SHAPE,
        async (args): Promise<AppToolResult> => {
            const removed = await operations.remove(args.id);

            return removed
                ? textResult('The server was removed.')
                : textResult('No connected server has that id.', true);
        },
    );

    return [connectTool, listTool, removeTool] as CloudbotTool[];
}

export { APP_TOOL_FULL_NAMES, createAppTools };
