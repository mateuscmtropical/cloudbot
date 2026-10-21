import { Hono } from 'hono';

import type { BotRule } from '../../shared/chatTypes.ts';
import type { BotRuleRecord, RuleStore } from '../store/RuleStore.ts';
import { isRuleInputError, parseRuleInput } from './parseRuleInput.ts';

interface RuleErrorResponse {
    error: string;
}

// Rules are owner settings. These routes sit behind the session check, and the bot has no tool for them.
interface RuleRoutesOptions {
    ruleStore: RuleStore;
    hasBot: (botId: string) => Promise<boolean>;
}

const BOT_NOT_FOUND: RuleErrorResponse = { error: 'No bot has this id.' };
const RULE_NOT_FOUND: RuleErrorResponse = { error: 'This bot has no rule with this id.' };
const INVALID_JSON: RuleErrorResponse = { error: 'Send a valid JSON body.' };

function toBotRule(record: BotRuleRecord): BotRule {
    return { id: record.id, kind: record.kind, text: record.text, blockedTools: record.blockedTools };
}

function createRuleRoutes(options: RuleRoutesOptions): Hono {
    const routes = new Hono();

    routes.get('/api/bots/:id/rules', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        const records = await options.ruleStore.list(botId);
        const rules = records.map(toBotRule);

        return context.json(rules);
    });

    routes.post('/api/bots/:id/rules', async (context) => {
        const botId = context.req.param('id');
        const isKnownBot = await options.hasBot(botId);

        if (!isKnownBot) {
            return context.json(BOT_NOT_FOUND, 404);
        }

        let payload: unknown;

        try {
            payload = await context.req.json();
        } catch {
            return context.json(INVALID_JSON, 400);
        }

        const parsed = parseRuleInput(payload);

        if (isRuleInputError(parsed)) {
            return context.json(parsed, 400);
        }

        const record = await options.ruleStore.add(botId, parsed);
        const rule = toBotRule(record);

        return context.json(rule, 201);
    });

    routes.delete('/api/bots/:id/rules/:ruleId', async (context) => {
        const botId = context.req.param('id');
        const ruleId = context.req.param('ruleId');
        const isRemoved = await options.ruleStore.remove(botId, ruleId);

        if (!isRemoved) {
            return context.json(RULE_NOT_FOUND, 404);
        }

        return context.body(null, 204);
    });

    return routes;
}

export { createRuleRoutes, toBotRule };
export type { RuleRoutesOptions };
