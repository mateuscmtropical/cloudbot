import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ChatWebhookUrlEvent } from '../../shared/chatTypes.ts';
import type { WebhookStore } from '../store/WebhookStore.ts';
import { addBotWebhook } from './createWebhookRoutes.ts';

interface WebhookToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The URL never reaches the model. create hands it to the open web app as a live event, and only when one is listening.
const WEBHOOK_LIST_TOOL_NAME = 'webhook_list';
const WEBHOOK_CREATE_TOOL_NAME = 'webhook_create';
const WEBHOOK_DELETE_TOOL_NAME = 'webhook_delete';
const WEBHOOK_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_LIST_TOOL_NAME}`;
const WEBHOOK_CREATE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_CREATE_TOOL_NAME}`;
const WEBHOOK_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_DELETE_TOOL_NAME}`;
const WEBHOOK_TOOL_FULL_NAMES = [
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_CREATE_TOOL_FULL_NAME,
    WEBHOOK_DELETE_TOOL_FULL_NAME,
];

const LIST_DESCRIPTION = 'List your webhooks with their ids and names. The URLs are not listed again.';
const CREATE_DESCRIPTION = 'Make a webhook for the owner, named after the service that will send to it, such as "form tool". The URL is shown to the owner in the web app only, and you never see it. The owner must have the web app open.';
const DELETE_DESCRIPTION = 'Delete one of your webhooks by id. Its URL stops working.';

const NO_LISTENER_TEXT = 'No web app is open for this bot, so no webhook was made. Ask the owner to open the web app, or to make the webhook in the Routines panel, and then try again.';

const LIST_SHAPE = {};
const CREATE_SHAPE = { name: z.string() };
const ID_SHAPE = { id: z.string() };

// How the tool reaches the owner. The URL goes out as a live event, and is never stored.
interface WebhookCreation {
    publicBaseUrl: string;
    isListening: (botId: string) => boolean;
    announce: (event: ChatWebhookUrlEvent) => void;
}

function textResult(text: string, isError = false): WebhookToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createWebhookTools(store: WebhookStore, botId: string, creation: WebhookCreation): CloudbotTool[] {
    const listTool = tool(
        WEBHOOK_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<WebhookToolResult> => {
            const webhooks = await store.list(botId);

            if (webhooks.length === 0) {
                return textResult('You have no webhooks.');
            }

            const lines = webhooks.map(webhook => `- ${webhook.id}: "${webhook.name}"`);
            const listText = lines.join('\n');

            return textResult(listText);
        },
    );
    const createTool = tool(
        WEBHOOK_CREATE_TOOL_NAME,
        CREATE_DESCRIPTION,
        CREATE_SHAPE,
        async (args): Promise<WebhookToolResult> => {
            if (!creation.isListening(botId)) {
                return textResult(NO_LISTENER_TEXT, true);
            }

            const result = await addBotWebhook(store, botId, { name: args.name }, creation.publicBaseUrl);

            if ('problem' in result) {
                return textResult(result.problem.error, true);
            }

            const { created } = result;

            // The web app may have closed while the webhook was made. Its URL would then reach nobody, so it is removed.
            if (!creation.isListening(botId)) {
                await store.remove(botId, created.id);

                return textResult(NO_LISTENER_TEXT, true);
            }

            creation.announce({ type: 'webhookUrl', botId, name: created.name, url: created.url });

            return textResult(`Made the webhook "${created.name}". The owner sees its URL in the web app and keeps it secret. You cannot see the URL. If the owner says no URL showed up, delete this webhook and make a new one.`);
        },
    );
    const deleteTool = tool(
        WEBHOOK_DELETE_TOOL_NAME,
        DELETE_DESCRIPTION,
        ID_SHAPE,
        async (args): Promise<WebhookToolResult> => {
            const isRemoved = await store.remove(botId, args.id);

            return isRemoved ? textResult('The webhook is deleted.') : textResult('You have no webhook with this id.', true);
        },
    );

    return [listTool, createTool, deleteTool] as CloudbotTool[];
}

export {
    WEBHOOK_CREATE_TOOL_FULL_NAME,
    WEBHOOK_DELETE_TOOL_FULL_NAME,
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_TOOL_FULL_NAMES,
    createWebhookTools,
};
export type { WebhookCreation, WebhookToolResult };
