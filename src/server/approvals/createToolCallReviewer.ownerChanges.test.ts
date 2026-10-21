import { describe, expect, it, vi } from 'vitest';

import { classifyToolCall } from './classifyToolCall.ts';
import { createToolCallReviewer } from './createToolCallReviewer.ts';
import { describeLimitChange } from '../limits/createLimitTools.ts';
import { describeRuleChange } from '../rules/describeRuleChange.ts';
import type { RuleStore } from '../store/RuleStore.ts';

const RULE_CHANGE = 'mcp__cloudbot__rule_change';
const RULE_LIST = 'mcp__cloudbot__rule_list';
const BOT_DELETE = 'mcp__cloudbot__bot_delete';
const LIMITS_SET = 'mcp__cloudbot__limits_set';

function fakeRuleStore(rules: { id: string; kind: 'allow' | 'block'; text: string; blockedTools: string[] }[]): RuleStore {
    return {
        list: () => Promise.resolve(rules.map(rule => ({ ...rule, botId: 'bot-1', createdAt: 0 }))),
    } as unknown as RuleStore;
}

const signal = new AbortController().signal;

describe('rule and delete approvals', () => {
    it('always asks the owner for a rule change, and lets the rule list through', () => {
        expect(classifyToolCall({ toolName: RULE_CHANGE, input: {} }))
            .toBe('always-ask');
        expect(classifyToolCall({ toolName: RULE_LIST, input: {} }))
            .toBe('skip');
    });

    it('shows the kind and text of a new rule on the card', async () => {
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeRuleChange: (botId, input) => describeRuleChange(fakeRuleStore([]), botId, input),
        });

        const verdict = await reviewer('bot-1', {
            toolName: RULE_CHANGE,
            input: { action: 'add', kind: 'allow', text: 'Read the weather.' },
        }, signal);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Add a rule to this bot.', detail: 'Rule (allow): "Read the weather."' });
    });

    it('shows the target and the whole text of a hand-off the review asks about', async () => {
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{"category":"other","decision":"ask","summary":"Send a task to Ben.","reason":""}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
        });

        const verdict = await reviewer('bot-1', {
            toolName: 'mcp__cloudbot__bot_send',
            input: { bot: 'Ben', text: 'Summarize the notes.' },
        }, signal);

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Send a task to Ben.', detail: 'Bot: Ben\n\nSummarize the notes.' });
    });

    it('lets a hand-off the review allows run without a card', async () => {
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{"category":"other","decision":"allow","summary":"","reason":""}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
        });

        const verdict = await reviewer('bot-1', {
            toolName: 'mcp__cloudbot__bot_send',
            input: { bot: 'Ben', text: 'Summarize the notes.' },
        }, signal);

        expect(verdict)
            .toEqual({ decision: 'allow' });
    });

    it('denies a block rule with a tool name that is not valid', async () => {
        const verdict = await describeRuleChange(fakeRuleStore([]), 'bot-1', {
            action: 'add',
            kind: 'allow',
            text: 'Browse.',
            blockedTools: ['Bash'],
        });

        expect(verdict.decision)
            .toBe('deny');
    });

    it('denies removing a rule id the bot does not have', async () => {
        const verdict = await describeRuleChange(fakeRuleStore([]), 'bot-1', { action: 'remove', ruleId: 'missing' });

        expect(verdict.decision)
            .toBe('deny');
    });

    it('asks to remove a known rule and shows its text', async () => {
        const store = fakeRuleStore([{ id: 'rule-1', kind: 'block', text: 'Never post.', blockedTools: [] }]);
        const verdict = await describeRuleChange(store, 'bot-1', { action: 'remove', ruleId: 'rule-1' });

        expect(verdict)
            .toEqual({ decision: 'ask', summary: 'Remove a rule of this bot.', detail: 'Rule to remove (block): "Never post."' });
    });

    it('asks the owner to delete the bot with its name, and refuses the last bot', async () => {
        const checks = [
            { ok: true as const, name: 'Ana' },
            { ok: false as const, reason: 'This is the last bot, so it cannot be deleted.' },
        ];
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeBotDelete: () => Promise.resolve(checks[0]!),
        });

        const asked = await reviewer('bot-1', { toolName: BOT_DELETE, input: {} }, signal);

        expect(asked.decision)
            .toBe('ask');
        expect(asked)
            .toEqual(expect.objectContaining({ summary: 'Delete the bot "Ana".' }));

        const refuser = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeBotDelete: () => Promise.resolve(checks[1]!),
        });

        const refused = await refuser('bot-1', { toolName: BOT_DELETE, input: {} }, signal);

        expect(refused)
            .toEqual({ decision: 'deny', reason: 'This is the last bot, so it cannot be deleted.' });
    });

    it('refuses a rule change, a bot delete or a limit change when its card cannot be built', async () => {
        const reviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
        });

        const verdicts = await Promise.all([RULE_CHANGE, BOT_DELETE, LIMITS_SET].map(toolName => reviewer('bot-1', { toolName, input: {} }, signal)));

        verdicts.forEach((verdict) => {
            expect(verdict.decision)
                .toBe('deny');
        });
    });

    it('refuses to delete a bot whose name has hidden characters, and quotes the name on the card', async () => {
        const hiddenName = `Ana${String.fromCodePoint(0x202e)}`;
        const hiddenReviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeBotDelete: () => Promise.resolve({ ok: true, name: hiddenName }),
        });
        const hidden = await hiddenReviewer('bot-1', { toolName: BOT_DELETE, input: {} }, signal);

        expect(hidden.decision)
            .toBe('deny');

        const plainReviewer = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeBotDelete: () => Promise.resolve({ ok: true, name: 'Ana' }),
        });
        const plain = await plainReviewer('bot-1', { toolName: BOT_DELETE, input: {} }, signal);

        expect(plain)
            .toEqual(expect.objectContaining({ summary: 'Delete the bot "Ana".' }));
    });

    it('shows the old and new value of each limit on the card', async () => {
        const stored = { chat: { minutes: 10, usd: null, steps: null }, routines: { minutes: null, usd: null, steps: null } };
        const verdict = await describeLimitChange({ get: () => Promise.resolve(stored) }, 'bot-1', { chatMinutes: 30 });

        expect(verdict)
            .toEqual({
                decision: 'ask',
                summary: 'Change the limits of this bot.',
                detail: [
                    'Chat time (minutes): 10 -> 30',
                    'Chat spending (USD): none -> none',
                    'Chat steps: none -> none',
                    'Routine time (minutes): none -> none',
                    'Routine spending (USD): none -> none',
                    'Routine steps: none -> none',
                ].join('\n'),
            });
    });
});
