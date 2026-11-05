import { Hono } from 'hono';

import type { WebhookRecord, WebhookStore } from '../store/WebhookStore.ts';
import { ANY_PROVIDER } from '../../shared/webhookTypes.ts';
import type { BotWebhook, CreatedBotWebhook, WebhookCall, WebhookRefusal } from '../../shared/webhookTypes.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhookMemory.ts';
import { buildWebhookUrl, createWebhookToken, hashWebhookToken } from './webhookToken.ts';

interface WebhookErrorResponse {
    error: string;
}

// Webhooks are created, listed and removed here by the owner. The token and its hash are never listed.
interface WebhookRoutesOptions {
    webhookStore: WebhookStore;
    hasBot: (botId: string) => Promise<boolean>;
    // The address the owner reaches the server at. A new webhook URL starts with it.
    publicBaseUrl: string;
    // The refused calls shown with each webhook in the list.
    refusals?: WebhookRefusalLog;
    // The delivery ids of each webhook. They are dropped when the webhook is deleted.
    deliveries?: DeliveryMemory;
}

const MAX_WEBHOOKS_PER_BOT = 10;
const MAX_NAME_LENGTH = 60;
const MAX_RULES_PER_WEBHOOK = 20;
const MAX_INSTRUCTION_LENGTH = 500;
const PROVIDER_NAME_PATTERN = /^[a-z0-9_-]{1,40}$/;

const BOT_NOT_FOUND: WebhookErrorResponse = { error: 'No bot has this id.' };
const WEBHOOK_NOT_FOUND: WebhookErrorResponse = { error: 'This bot has no webhook with this id.' };
const INVALID_NAME: WebhookErrorResponse = { error: `Send a name of 1 to ${String(MAX_NAME_LENGTH)} characters on one line.` };
const TOO_MANY: WebhookErrorResponse = { error: `This bot has ${String(MAX_WEBHOOKS_PER_BOT)} webhooks. Delete one first.` };
const INVALID_PROVIDER: WebhookErrorResponse = { error: `Name the provider in lower case letters, digits, - or _, or use ${ANY_PROVIDER} for any other caller.` };
const INVALID_INSTRUCTION: WebhookErrorResponse = { error: `Send an instruction of at most ${String(MAX_INSTRUCTION_LENGTH)} characters on one line. An empty one removes the rule.` };
const TOO_MANY_RULES: WebhookErrorResponse = { error: `This webhook has ${String(MAX_RULES_PER_WEBHOOK)} rules. Remove one first.` };

function toBotWebhook(record: WebhookRecord, refusals: WebhookRefusal[] = [], calls: WebhookCall[] = []): BotWebhook {
    const ruleEntries = Object.entries(record.rules);

    return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        refusals,
        rules: ruleEntries.map(([provider, instruction]) => ({ provider, instruction })),
        calls,
    };
}

interface SaveWebhookRuleProblem {
    problem: WebhookErrorResponse;
    status: 400 | 404;
}

interface SaveWebhookRuleSuccess {
    saved: WebhookRecord;
}

type SaveWebhookRuleResult = SaveWebhookRuleProblem | SaveWebhookRuleSuccess;

// Shared by the owner route and the bot's webhook_rule_set tool. The instruction becomes part of the first line of each
// message, so it must stay on one line. An empty instruction removes the rule.
async function saveWebhookRule(webhookStore: WebhookStore, botId: string, webhookId: string, provider: string, instruction: string): Promise<SaveWebhookRuleResult> {
    const trimmedInstruction = instruction.trim();

    if (provider !== ANY_PROVIDER && !PROVIDER_NAME_PATTERN.test(provider)) {
        return { problem: INVALID_PROVIDER, status: 400 };
    }

    if (trimmedInstruction.length > MAX_INSTRUCTION_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(trimmedInstruction)) {
        return { problem: INVALID_INSTRUCTION, status: 400 };
    }

    const webhooks = await webhookStore.list(botId);
    const webhook = webhooks.find(known => known.id === webhookId);

    if (webhook === undefined) {
        return { problem: WEBHOOK_NOT_FOUND, status: 404 };
    }

    const ruleEntries = Object.entries(webhook.rules);
    const otherEntries = ruleEntries.filter(([ruleProvider]) => ruleProvider !== provider);
    const otherRules = Object.fromEntries(otherEntries);

    if (trimmedInstruction !== '' && otherEntries.length >= MAX_RULES_PER_WEBHOOK) {
        return { problem: TOO_MANY_RULES, status: 400 };
    }

    const rules = trimmedInstruction === '' ? otherRules : { ...otherRules, [provider]: trimmedInstruction };
    const saved = await webhookStore.setRules(botId, webhookId, rules);

    return saved === undefined ? { problem: WEBHOOK_NOT_FOUND, status: 404 } : { saved };
}

// The name becomes part of the chat message, so it must stay on one line.
function readWebhookName(payload: unknown): string | undefined {
    const name = typeof payload === 'object' && payload !== null && 'name' in payload ? payload.name : undefined;

    if (typeof name !== 'string') {
        return undefined;
    }

    const trimmedName = name.trim();
    const isValid = trimmedName.length >= 1 && trimmedName.length <= MAX_NAME_LENGTH && !/[\r\n]/.test(trimmedName);

    return isValid ? trimmedName : undefined;
}

interface AddBotWebhookProblem {
    problem: WebhookErrorResponse;
}

interface AddBotWebhookSuccess {
    created: CreatedBotWebhook;
}

type AddBotWebhookResult = AddBotWebhookProblem | AddBotWebhookSuccess;

// Shared by the owner route and the bot's webhook_create tool, so both follow the same name and limit rules.
async function addBotWebhook(webhookStore: WebhookStore, botId: string, payload: unknown, publicBaseUrl: string): Promise<AddBotWebhookResult> {
    const name = readWebhookName(payload);

    if (name === undefined) {
        return { problem: INVALID_NAME };
    }

    const existingWebhooks = await webhookStore.list(botId);

    if (existingWebhooks.length >= MAX_WEBHOOKS_PER_BOT) {
        return { problem: TOO_MANY };
    }

    const token = createWebhookToken();
    const tokenHash = hashWebhookToken(token);
    const webhook = await webhookStore.add(botId, name, tokenHash);
    const url = buildWebhookUrl(publicBaseUrl, token);
    const created: CreatedBotWebhook = { ...toBotWebhook(webhook), url };

    return { created };
}

// These routes sit behind the session check.
function createWebhookRoutes(options: WebhookRoutesOptions): Hono {
    const routes = new Hono();
    const refusals = options.refusals ?? new WebhookRefusalLog();
    const deliveries = options.deliveries ?? new DeliveryMemory();

    routes.get('/api/bots/:id/webhooks', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.webhookStore.list(botId);
        const webhookRequests = records.map(async (record) => {
            const recordRefusals = refusals.list(record.id);
            const calls = await options.webhookStore.listCalls(record.id);

            return toBotWebhook(record, recordRefusals, calls);
        });
        const botWebhooks = await Promise.all(webhookRequests);

        return context.json(botWebhooks);
    });

    routes.post('/api/bots/:id/webhooks', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const result = await addBotWebhook(options.webhookStore, botId, payload, options.publicBaseUrl);

        if ('problem' in result) {
            return context.json(result.problem, 400);
        }

        return context.json(result.created, 201);
    });

    routes.put('/api/bots/:id/webhooks/:webhookId/rules/:provider', async (context) => {
        const payload: unknown = await context.req.json()
            .catch(() => undefined);
        const instruction = typeof payload === 'object' && payload !== null && 'instruction' in payload ? payload.instruction : undefined;

        if (typeof instruction !== 'string') {
            return context.json(INVALID_INSTRUCTION, 400);
        }

        const botId = context.req.param('id');
        const webhookId = context.req.param('webhookId');
        const provider = context.req.param('provider');
        const result = await saveWebhookRule(options.webhookStore, botId, webhookId, provider, instruction);

        if ('problem' in result) {
            return context.json(result.problem, result.status);
        }

        const recordRefusals = refusals.list(webhookId);
        const calls = await options.webhookStore.listCalls(webhookId);
        const webhook = toBotWebhook(result.saved, recordRefusals, calls);

        return context.json(webhook);
    });

    routes.delete('/api/bots/:id/webhooks/:webhookId', async (context) => {
        const botId = context.req.param('id');
        const webhookId = context.req.param('webhookId');
        const isRemoved = await options.webhookStore.remove(botId, webhookId);

        if (!isRemoved) {
            return context.json(WEBHOOK_NOT_FOUND, 404);
        }

        refusals.forget(webhookId);
        deliveries.forget(webhookId);

        return context.body(null, 204);
    });

    return routes;
}

export { MAX_INSTRUCTION_LENGTH, MAX_NAME_LENGTH, MAX_RULES_PER_WEBHOOK, MAX_WEBHOOKS_PER_BOT, addBotWebhook, createWebhookRoutes, saveWebhookRule, toBotWebhook };
export type { AddBotWebhookResult, BotWebhook, CreatedBotWebhook, WebhookRoutesOptions };
