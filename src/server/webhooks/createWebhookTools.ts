import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { WebhookStore } from '../store/WebhookStore.ts';

interface WebhookToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The owner creates webhooks in the Routines panel, because the URL would otherwise pass through the chat.
const WEBHOOK_LIST_TOOL_NAME = 'webhook_list';
const WEBHOOK_DELETE_TOOL_NAME = 'webhook_delete';
const WEBHOOK_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_LIST_TOOL_NAME}`;
const WEBHOOK_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_DELETE_TOOL_NAME}`;
const WEBHOOK_TOOL_FULL_NAMES = [
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_DELETE_TOOL_FULL_NAME,
];

const LIST_DESCRIPTION = 'List your webhooks with their ids and names. The URLs are not listed again.';
const DELETE_DESCRIPTION = 'Delete one of your webhooks by id. Its URL stops working.';

const LIST_SHAPE = {};
const ID_SHAPE = { id: z.string() };

function textResult(text: string, isError = false): WebhookToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createWebhookTools(store: WebhookStore, botId: string): CloudbotTool[] {
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
    const deleteTool = tool(
        WEBHOOK_DELETE_TOOL_NAME,
        DELETE_DESCRIPTION,
        ID_SHAPE,
        async (args): Promise<WebhookToolResult> => {
            const isRemoved = await store.remove(botId, args.id);

            return isRemoved ? textResult('The webhook is deleted.') : textResult('You have no webhook with this id.', true);
        },
    );

    return [listTool, deleteTool] as CloudbotTool[];
}

export {
    WEBHOOK_DELETE_TOOL_FULL_NAME,
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_TOOL_FULL_NAMES,
    createWebhookTools,
};
export type { WebhookToolResult };
