import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { ChatWebhookUrlEvent } from '../../shared/chatTypes.ts';
import type { WebhookRefusal } from '../../shared/webhookTypes.ts';
import type { WebhookStore } from '../store/WebhookStore.ts';
import { addBotWebhook, saveWebhookRule } from './createWebhookRoutes.ts';
import { createDefaultOutgoingWebhookSender, OutgoingWebhookError } from './sendOutgoingWebhook.ts';
import type { SendOutgoingWebhook } from './sendOutgoingWebhook.ts';
import { describeWebhookCaller } from './webhookCaller.ts';
import { OUTSIDE_DATA_LINE } from './webhookMessage.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhookMemory.ts';

interface WebhookToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The URL never reaches the model. create hands it to the open web app as a live event, and only when one is listening.
const WEBHOOK_LIST_TOOL_NAME = 'webhook_list';
const WEBHOOK_CREATE_TOOL_NAME = 'webhook_create';
const WEBHOOK_DELETE_TOOL_NAME = 'webhook_delete';
const WEBHOOK_RULE_SET_TOOL_NAME = 'webhook_rule_set';
const WEBHOOK_SEND_TOOL_NAME = 'webhook_send';
const WEBHOOK_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_LIST_TOOL_NAME}`;
const WEBHOOK_CREATE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_CREATE_TOOL_NAME}`;
const WEBHOOK_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_DELETE_TOOL_NAME}`;
const WEBHOOK_RULE_SET_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_RULE_SET_TOOL_NAME}`;
const WEBHOOK_SEND_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WEBHOOK_SEND_TOOL_NAME}`;
const WEBHOOK_TOOL_FULL_NAMES = [
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_CREATE_TOOL_FULL_NAME,
    WEBHOOK_DELETE_TOOL_FULL_NAME,
    WEBHOOK_RULE_SET_TOOL_FULL_NAME,
    WEBHOOK_SEND_TOOL_FULL_NAME,
];

const LIST_DESCRIPTION = 'List your webhooks with their ids, names, rules and last callers. The URLs are not listed again.';
const RULE_SET_DESCRIPTION = 'Say what to do with the calls of one provider to a webhook, such as github or stripe, or * for any other caller. The list of webhooks shows the providers that called. Each call from that provider then starts with this instruction. An empty instruction removes the rule. Use it when the owner asks.';
const SEND_DESCRIPTION = 'Send a webhook to an outside service: one http request to a public address, POST by default. The answer comes back to you as data from outside. Redirects are not followed.';
const CREATE_DESCRIPTION = 'Make a webhook for the owner, named after the service that will send to it, such as "form tool". The URL is shown to the owner in the web app only, and you never see it. The owner must have the web app open.';
const DELETE_DESCRIPTION = 'Delete one of your webhooks by id. Its URL stops working.';

const NO_LISTENER_TEXT = 'No web app is open for this bot, so no webhook was made. Ask the owner to open the web app, or to make the webhook under Webhooks in your profile, and then try again.';

const LIST_SHAPE = {};
const CREATE_SHAPE = { name: z.string() };
const ID_SHAPE = { id: z.string() };
const RULE_SET_SHAPE = { id: z.string(), provider: z.string(), instruction: z.string() };
const METHOD_SCHEMA = z.enum(['POST', 'PUT', 'PATCH', 'DELETE', 'GET']);
const HEADER_TEXT_SCHEMA = z.string();
const HEADERS_SCHEMA = z.record(HEADER_TEXT_SCHEMA, HEADER_TEXT_SCHEMA);
const BODY_SCHEMA = z.string();
const SEND_SHAPE = {
    url: z.string(),
    method: METHOD_SCHEMA.optional(),
    headers: HEADERS_SCHEMA.optional(),
    body: BODY_SCHEMA.optional(),
};
const LISTED_CALLS = 5;

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

function describeRefusals(refusalList: WebhookRefusal[]): string {
    if (refusalList.length === 0) {
        return '';
    }

    const reasons = refusalList.map(refusal => refusal.reason);

    return `, refused recently: ${reasons.join(', ')}`;
}

function describeRules(rules: Record<string, string>): string {
    const lines = Object.entries(rules)
        .map(([provider, instruction]) => `\n  rule for ${provider}: ${instruction}`);

    return lines.join('');
}

function createWebhookTools(store: WebhookStore, botId: string, creation: WebhookCreation, refusals: WebhookRefusalLog = new WebhookRefusalLog(), deliveries: DeliveryMemory = new DeliveryMemory(), sendOutgoing: SendOutgoingWebhook = createDefaultOutgoingWebhookSender()): CloudbotTool[] {
    const listTool = tool(
        WEBHOOK_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        LIST_SHAPE,
        async (): Promise<WebhookToolResult> => {
            const webhooks = await store.list(botId);

            if (webhooks.length === 0) {
                return textResult('You have no webhooks.');
            }

            // The refusals name only the reason, never the body, the token or the delivery id.
            const lineRequests = webhooks.map(async (webhook) => {
                const refusalList = refusals.list(webhook.id);
                const calls = await store.listCalls(webhook.id);
                const callLines = calls.slice(0, LISTED_CALLS)
                    .map((call) => {
                        const time = new Date(call.time);

                        return `\n  call at ${time.toISOString()}: ${describeWebhookCaller(call)}`;
                    });

                return `- ${webhook.id}: "${webhook.name}"${describeRefusals(refusalList)}${describeRules(webhook.rules)}${callLines.join('')}`;
            });
            const lines = await Promise.all(lineRequests);
            const listText = lines.join('\n');
            // The callers come from outside, so they are marked as data like a webhook message.
            const hasCalls = listText.includes('\n  call at ');

            if (hasCalls) {
                return textResult(`${listText}\n\n${OUTSIDE_DATA_LINE.replace('below', 'in the call lines above')}`);
            }

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

            if (!isRemoved) {
                return textResult('You have no webhook with this id.', true);
            }

            // The deleted webhook keeps no refused calls or delivery ids, as the owner's delete route does.
            refusals.forget(args.id);
            deliveries.forget(args.id);

            return textResult('The webhook is deleted.');
        },
    );

    const ruleSetTool = tool(
        WEBHOOK_RULE_SET_TOOL_NAME,
        RULE_SET_DESCRIPTION,
        RULE_SET_SHAPE,
        async (args): Promise<WebhookToolResult> => {
            const result = await saveWebhookRule(store, botId, args.id, args.provider, args.instruction);

            if ('problem' in result) {
                return textResult(result.problem.error, true);
            }

            return textResult(args.instruction.trim() === '' ? 'The rule is removed.' : 'The rule is saved.');
        },
    );
    const sendTool = tool(
        WEBHOOK_SEND_TOOL_NAME,
        SEND_DESCRIPTION,
        SEND_SHAPE,
        async (args): Promise<WebhookToolResult> => {
            try {
                const answer = await sendOutgoing({ url: args.url, method: args.method, headers: args.headers, body: args.body });

                return textResult(`The server answered ${String(answer.status)}.\n${OUTSIDE_DATA_LINE}\n\n${answer.text}`);
            } catch (error: unknown) {
                if (error instanceof OutgoingWebhookError) {
                    return textResult(error.message, true);
                }

                return textResult('The request failed before the server answered.', true);
            }
        },
    );

    return [listTool, createTool, deleteTool, ruleSetTool, sendTool] as CloudbotTool[];
}

export {
    WEBHOOK_CREATE_TOOL_FULL_NAME,
    WEBHOOK_DELETE_TOOL_FULL_NAME,
    WEBHOOK_LIST_TOOL_FULL_NAME,
    WEBHOOK_RULE_SET_TOOL_FULL_NAME,
    WEBHOOK_SEND_TOOL_FULL_NAME,
    WEBHOOK_TOOL_FULL_NAMES,
    createWebhookTools,
};
export type { WebhookCreation, WebhookToolResult };
