import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { createRuleRoutes, MAX_RULES_PER_BOT } from './createRuleRoutes.ts';
import { RuleStore } from './RuleStore.ts';

function sendJson(app: Hono, method: string, path: string, body: unknown): Response | Promise<Response> {
    return app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('createRuleRoutes', () => {
    let opened: OpenedDatabase;
    let botId: string;
    let ruleStore: RuleStore;
    let app: Hono;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');

        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
        ruleStore = new RuleStore(opened.db);
        app = new HonoApp();
        app.route('/', createRuleRoutes(botStore, ruleStore));
    });

    afterEach(() => {
        opened.close();
    });

    it('adds a rule and lists it', async () => {
        const created = await sendJson(app, 'POST', `/api/bots/${botId}/rules`, {
            kind: 'block', sentence: '  Never send email.  ', blockedTools: ['Bash'],
        });
        const createdBody = await created.json() as { rule: { sentence: string } };
        const listed = await app.request(`/api/bots/${botId}/rules`);
        const listedBody = await listed.json() as { rules: { sentence: string; blockedTools: string[] }[] };

        expect(created.status)
            .toBe(201);
        expect(createdBody.rule.sentence)
            .toBe('Never send email.');
        expect(listedBody.rules)
            .toMatchObject([{ sentence: 'Never send email.', blockedTools: ['Bash'] }]);
    });

    it('answers 404 for an unknown bot', async () => {
        const listed = await app.request('/api/bots/missing/rules');
        const created = await sendJson(app, 'POST', '/api/bots/missing/rules', { kind: 'allow', sentence: 'Ok.' });

        expect(listed.status)
            .toBe(404);
        expect(created.status)
            .toBe(404);
    });

    it.each([
        ['not json', 'oops'],
        ['a list', []],
        ['an unknown kind', { kind: 'maybe', sentence: 'x' }],
        ['an empty sentence', { kind: 'allow', sentence: '   ' }],
        ['a long sentence', { kind: 'allow', sentence: 'x'.repeat(501) }],
        ['tool names that are not a list', { kind: 'block', sentence: 'x', blockedTools: 'Bash' }],
        ['a bad tool name', { kind: 'block', sentence: 'x', blockedTools: ['Bash; rm'] }],
        ['tools on an allow rule', { kind: 'allow', sentence: 'x', blockedTools: ['Bash'] }],
    ])('rejects %s', async (_label, body) => {
        const response = await sendJson(app, 'POST', `/api/bots/${botId}/rules`, body);

        expect(response.status)
            .toBe(400);
        expect(await ruleStore.listForBot(botId))
            .toEqual([]);
    });

    it('refuses a rule past the limit', async () => {
        const additions = Array.from({ length: MAX_RULES_PER_BOT }, () => ruleStore.add(botId, { kind: 'allow', sentence: 'x', blockedTools: [] }));

        await Promise.all(additions);

        const response = await sendJson(app, 'POST', `/api/bots/${botId}/rules`, { kind: 'allow', sentence: 'one more' });

        expect(response.status)
            .toBe(409);
    });

    it('removes a rule and answers 404 for an unknown one', async () => {
        const rule = await ruleStore.add(botId, { kind: 'allow', sentence: 'x', blockedTools: [] });
        const removed = await app.request(`/api/bots/${botId}/rules/${rule.id}`, { method: 'DELETE' });
        const removedAgain = await app.request(`/api/bots/${botId}/rules/${rule.id}`, { method: 'DELETE' });

        expect(removed.status)
            .toBe(200);
        expect(removedAgain.status)
            .toBe(404);
    });
});
