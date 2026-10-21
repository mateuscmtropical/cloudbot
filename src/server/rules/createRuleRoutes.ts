import { Hono } from 'hono';

import type { BotStore } from '../store/BotStore.ts';
import { RULE_KINDS } from '../store/ruleKinds.ts';
import type { RuleKind } from '../store/ruleKinds.ts';
import type { NewBotRule, RuleStore } from './RuleStore.ts';

interface RuleErrorResponse {
    error: string;
}

const MAX_RULES_PER_BOT = 50;
const MAX_SENTENCE_LENGTH = 500;
const MAX_BLOCKED_TOOLS = 20;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const BOT_NOT_FOUND: RuleErrorResponse = { error: 'No bot has this id.' };
const RULE_NOT_FOUND: RuleErrorResponse = { error: 'No rule of this bot has this id.' };
const TOO_MANY_RULES: RuleErrorResponse = { error: `A bot can have at most ${String(MAX_RULES_PER_BOT)} rules. Remove one first.` };

function isRuleKind(candidate: unknown): candidate is RuleKind {
    return RULE_KINDS.some(kind => kind === candidate);
}

function readBlockedTools(candidate: unknown): string[] | undefined {
    if (candidate === undefined) {
        return [];
    }

    const isValidList = Array.isArray(candidate)
        && candidate.length <= MAX_BLOCKED_TOOLS
        && candidate.every(entry => typeof entry === 'string' && TOOL_NAME_PATTERN.test(entry));

    return isValidList ? candidate as string[] : undefined;
}

// Returns the rule to store, or the message that tells the owner what to fix.
function parseNewRule(requestBody: unknown): NewBotRule | RuleErrorResponse {
    if (typeof requestBody !== 'object' || requestBody === null) {
        return { error: 'Send a JSON object with "kind" and "sentence".' };
    }

    const kind: unknown = Reflect.get(requestBody, 'kind');

    if (!isRuleKind(kind)) {
        return { error: '"kind" must be "allow" or "block".' };
    }

    const rawSentence: unknown = Reflect.get(requestBody, 'sentence');
    const sentence = typeof rawSentence === 'string' ? rawSentence.trim() : '';

    if (sentence === '' || sentence.length > MAX_SENTENCE_LENGTH) {
        return { error: `"sentence" must be 1 to ${String(MAX_SENTENCE_LENGTH)} characters.` };
    }

    const rawBlockedTools: unknown = Reflect.get(requestBody, 'blockedTools');
    const blockedTools = readBlockedTools(rawBlockedTools);

    if (blockedTools === undefined) {
        return { error: `"blockedTools" must be a list of up to ${String(MAX_BLOCKED_TOOLS)} tool names, such as "Bash" or "browser_open".` };
    }

    if (kind === 'allow' && blockedTools.length > 0) {
        return { error: 'Only a block rule can name tools.' };
    }

    return { kind, sentence, blockedTools };
}

function isRuleError(parsedRule: NewBotRule | RuleErrorResponse): parsedRule is RuleErrorResponse {
    return 'error' in parsedRule;
}

// Mounted behind the session check, so only the owner reaches these routes.
function createRuleRoutes(botStore: BotStore, ruleStore: RuleStore): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:botId/rules', async (context) => {
        const botId = context.req.param('botId');
        const bot = await botStore.getById(botId);

        if (bot === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const rules = await ruleStore.listForBot(botId);

        return context.json({ rules });
    });

    routes.post('/api/bots/:botId/rules', async (context) => {
        const botId = context.req.param('botId');
        const bot = await botStore.getById(botId);

        if (bot === undefined) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        // Invalid JSON counts as a missing body, so it gets the same 400 as an empty one.
        let requestBody: unknown;

        try {
            requestBody = await context.req.json();
        } catch {
            requestBody = undefined;
        }

        const parsedRule = parseNewRule(requestBody);

        if (isRuleError(parsedRule)) {
            return context.json(parsedRule, 400);
        }

        const existingRules = await ruleStore.listForBot(botId);

        if (existingRules.length >= MAX_RULES_PER_BOT) {
            return context.json(TOO_MANY_RULES, 409);
        }

        const storedRule = await ruleStore.add(botId, parsedRule);

        return context.json({ rule: storedRule }, 201);
    });

    routes.delete('/api/bots/:botId/rules/:ruleId', async (context) => {
        const botId = context.req.param('botId');
        const ruleId = context.req.param('ruleId');
        const wasRemoved = await ruleStore.remove(botId, ruleId);

        if (!wasRemoved) {
            return context.json(RULE_NOT_FOUND, 404);
        }

        return context.json({ removed: true });
    });

    return routes;
}

export { createRuleRoutes, MAX_RULES_PER_BOT };
