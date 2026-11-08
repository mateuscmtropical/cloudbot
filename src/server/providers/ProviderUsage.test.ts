import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderUsage, describeProviderUsage, parseAgyUsage, parseClaudeUsage, parseCodexRateLimits, parseCopilotUsage, parseKimiUsage } from './ProviderUsage.ts';

// Taken from `claude -p "/usage"` (claude 2.1.319), cut down to the lines around the limits.
const CLAUDE_USAGE_TEXT = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 25% used · resets Nov 7, 11pm (America/Sao_Paulo)',
    'Current week (all models): 22% used · resets Nov 12, 4am (America/Sao_Paulo)',
    'Current week (Fable): 0% used · resets Nov 12, 4am (America/Sao_Paulo)',
    '',
    'What\'s contributing to your usage?',
    'Last 24h · 809 requests · 3 sessions',
    '  87%  Give "general-purpose" subagents a cheaper model',
].join('\n');

describe('parseClaudeUsage', () => {
    it('reads each limit line with its percent and reset text', () => {
        expect(parseClaudeUsage(CLAUDE_USAGE_TEXT))
            .toEqual([
                { label: 'Session', usedPercent: 25, resetsAt: null, resetsText: 'Nov 7, 11pm (America/Sao_Paulo)' },
                { label: 'Week (all models)', usedPercent: 22, resetsAt: null, resetsText: 'Nov 12, 4am (America/Sao_Paulo)' },
                { label: 'Week (Fable)', usedPercent: 0, resetsAt: null, resetsText: 'Nov 12, 4am (America/Sao_Paulo)' },
            ]);
    });

    it('keeps a limit that has no reset time', () => {
        expect(parseClaudeUsage('Current session: 3.5% used'))
            .toEqual([{ label: 'Session', usedPercent: 3.5, resetsAt: null, resetsText: null }]);
    });

    it('finds nothing in text that is not the usage screen', () => {
        expect(parseClaudeUsage('/usage is only available for subscription plans.'))
            .toEqual([]);
        expect(parseClaudeUsage(''))
            .toEqual([]);
    });
});

describe('parseCodexRateLimits', () => {
    const snapshot = {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
        planType: 'plus',
    };

    it('turns the primary and secondary windows into limits with epoch milliseconds', () => {
        expect(parseCodexRateLimits({ rateLimits: snapshot, rateLimitsByLimitId: null }))
            .toEqual([
                { label: '5 hour limit', usedPercent: 12, resetsAt: 1_800_000_000_000, resetsText: null },
                { label: 'Weekly limit', usedPercent: 40, resetsAt: 1_800_500_000_000, resetsText: null },
            ]);
    });

    it('names the buckets when the account has several', () => {
        const spark = { limitId: 'codex_spark', limitName: 'Spark', primary: { usedPercent: 1, windowDurationMins: 90, resetsAt: null }, secondary: null };
        const windows = parseCodexRateLimits({ rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot, codex_spark: spark } });

        expect(windows.map(window => window.label))
            .toEqual(['codex: 5 hour limit', 'codex: Weekly limit', 'Spark: 90 minute limit']);
        expect(windows[2]?.resetsAt)
            .toBeNull();
    });

    it('describes day windows and unknown lengths', () => {
        const windows = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 2880, resetsAt: null }, secondary: { usedPercent: 6, windowDurationMins: null, resetsAt: null } } });

        expect(windows.map(window => window.label))
            .toEqual(['2 day limit', 'Limit']);
    });

    it('finds nothing in a strange answer', () => {
        expect(parseCodexRateLimits(undefined))
            .toEqual([]);
        expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 'many' }, secondary: null } }))
            .toEqual([]);
    });
});

// The shape of `GET /copilot_internal/user` in the zod schema of @github/copilot 1.0.12. The numbers are made up.
const COPILOT_BODY = {
    login: 'octocat',
    copilot_plan: 'individual_pro',
    quota_reset_date: '2026-12-01',
    quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
    quota_snapshots: {
        chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, overage_count: 0, quota_id: 'chat' },
        completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, overage_count: 0, quota_id: 'completions' },
        premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80, unlimited: false, overage_permitted: true, overage_count: 0, quota_id: 'premium_interactions' },
    },
};

describe('parseCopilotUsage', () => {
    it('shows the premium requests and skips the unlimited snapshots', () => {
        expect(parseCopilotUsage(COPILOT_BODY))
            .toEqual([{ label: 'Premium requests', usedPercent: 20, resetsAt: Date.UTC(2026, 11, 1), resetsText: null }]);
    });

    it('shows the chat and completions of a limited plan, with the reset date alone', () => {
        const free = {
            ...COPILOT_BODY,
            quota_reset_date_utc: undefined,
            quota_snapshots: {
                chat: { entitlement: 50, remaining: 12, percent_remaining: 24, unlimited: false },
                completions: { entitlement: 2000, remaining: 1999, percent_remaining: 99.9, unlimited: false },
            },
        };

        expect(parseCopilotUsage(free))
            .toEqual([
                { label: 'Chat', usedPercent: 76, resetsAt: Date.UTC(2026, 11, 1), resetsText: null },
                { label: 'Completions', usedPercent: 0.1, resetsAt: Date.UTC(2026, 11, 1), resetsText: null },
            ]);
    });

    it('skips an entitlement of -1 and clamps a strange percent', () => {
        const body = { quota_snapshots: { chat: { entitlement: -1, percent_remaining: 40 }, premium_interactions: { entitlement: 10, percent_remaining: -5 } } };

        expect(parseCopilotUsage(body))
            .toEqual([{ label: 'Premium requests', usedPercent: 100, resetsAt: null, resetsText: null }]);
    });

    it('finds nothing in a strange answer', () => {
        expect(parseCopilotUsage(undefined))
            .toEqual([]);
        expect(parseCopilotUsage({ copilot_plan: 'free' }))
            .toEqual([]);
        expect(parseCopilotUsage({ quota_snapshots: { premium_interactions: { percent_remaining: 'most' } } }))
            .toEqual([]);
    });
});

// The shape of `GET /coding/v1/usages` read by parseManagedUsagePayload in Kimi Code 2.5.2. The numbers are made up.
const KIMI_BODY = {
    usages: {
        limit_5h: { used_ratio: 0.25, reset_time: '2026-11-07T23:00:00Z' },
        limit_7d: { used_ratio: '0.4', reset_time: '2026-11-12T04:00:00Z' },
        limit_month_total: { used_ratio: 0.1234 },
        limit_month_code: { used_ratio: 0.05 },
    },
    boosterWallet: null,
};

describe('parseKimiUsage', () => {
    it('turns the 5 hour, weekly and monthly ratios into limits', () => {
        expect(parseKimiUsage(KIMI_BODY))
            .toEqual([
                { label: '5 hour limit', usedPercent: 25, resetsAt: Date.UTC(2026, 10, 7, 23), resetsText: null },
                { label: 'Weekly limit', usedPercent: 40, resetsAt: Date.UTC(2026, 10, 12, 4), resetsText: null },
                { label: 'Monthly limit', usedPercent: 12.3, resetsAt: null, resetsText: null },
            ]);
    });

    it('skips a limit with no ratio', () => {
        expect(parseKimiUsage({ usages: { limit_5h: { reset_time: '2026-11-07T23:00:00Z' }, limit_7d: { used_ratio: 0 } } }))
            .toEqual([{ label: 'Weekly limit', usedPercent: 0, resetsAt: null, resetsText: null }]);
    });

    it('finds nothing in a strange answer', () => {
        expect(parseKimiUsage(null))
            .toEqual([]);
        expect(parseKimiUsage({ usages: [] }))
            .toEqual([]);
        expect(parseKimiUsage({ usages: { limit_5h: { used_ratio: 'lots' } } }))
            .toEqual([]);
    });
});

describe('ProviderUsage', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const window = { label: 'Session', usedPercent: 10, resetsAt: null, resetsText: null };

    it('asks the source of each provider and leaves a provider without one empty', async () => {
        const usage = new ProviderUsage({ claude: () => Promise.resolve([window]) });

        expect(await usage.read(['claude', 'gemini']))
            .toEqual([
                { provider: 'claude', label: 'Claude', windows: [window] },
                { provider: 'gemini', label: 'Gemini', windows: [] },
            ]);
    });

    it('keeps an answer for a minute and then asks again', async () => {
        vi.useFakeTimers();
        const claude = vi.fn(() => Promise.resolve([window]));
        const usage = new ProviderUsage({ claude });

        await usage.read(['claude']);
        await usage.read(['claude']);
        expect(claude)
            .toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(61_000);
        await usage.read(['claude']);
        expect(claude)
            .toHaveBeenCalledTimes(2);
    });

    it('shows a failing source as not available and asks again next time', async () => {
        const claude = vi.fn()
            .mockRejectedValueOnce(new Error('signed out'))
            .mockResolvedValueOnce([window]);
        const usage = new ProviderUsage({ claude });

        expect((await usage.read(['claude']))[0]?.windows)
            .toEqual([]);
        expect((await usage.read(['claude']))[0]?.windows)
            .toEqual([window]);
    });
});

describe('describeProviderUsage', () => {
    it('lists the limits and says when a provider has no usage', () => {
        const text = describeProviderUsage([
            { provider: 'claude', label: 'Claude', windows: [{ label: 'Session', usedPercent: 25, resetsAt: null, resetsText: 'Nov 7, 11pm' }] },
            { provider: 'chatgpt', label: 'ChatGPT', windows: [{ label: 'Weekly limit', usedPercent: 40, resetsAt: Date.UTC(2027, 0, 1), resetsText: null }] },
            { provider: 'gemini', label: 'Gemini', windows: [] },
        ]);

        expect(text)
            .toBe([
                'Claude: Session 25% used, resets Nov 7, 11pm.',
                'ChatGPT: Weekly limit 40% used, resets 2027-01-01T00:00:00.000Z.',
                'Gemini: not available for this provider.',
            ].join('\n'));
    });

    it('says so when no provider is connected', () => {
        expect(describeProviderUsage([]))
            .toBe('No provider is connected.');
    });
});

// The answer of `agy -p "/usage" --output-format json` in agy 1.5.3, cut to what the parser reads.
const AGY_BODY = {
    status: 'SUCCESS',
    command: {
        name: 'usage',
        data: {
            groups: [
                {
                    name: 'Gemini Models',
                    buckets: [
                        { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.97, reset_time: '2026-11-14T10:45:09Z' },
                        { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.944, reset_time: '2026-11-08T03:00:10Z' },
                    ],
                },
                { name: 'Claude and GPT models', buckets: [{ id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: 'soon' }] },
            ],
        },
    },
};

describe('parseAgyUsage', () => {
    it('turns each remaining share into a used percent, named by its group of models', () => {
        expect(parseAgyUsage(AGY_BODY))
            .toEqual([
                { label: 'Gemini Models: Weekly limit', usedPercent: 3, resetsAt: Date.UTC(2026, 10, 14, 10, 45, 9), resetsText: null },
                { label: 'Gemini Models: 5 hour limit', usedPercent: 5.6, resetsAt: Date.UTC(2026, 10, 8, 3, 0, 10), resetsText: null },
                { label: 'Claude and GPT models: 5 hour limit', usedPercent: 0, resetsAt: null, resetsText: null },
            ]);
    });

    it('finds nothing in a strange answer', () => {
        expect(parseAgyUsage(null))
            .toEqual([]);
        expect(parseAgyUsage({ command: { data: { groups: [{ buckets: [{ window: '5h' }] }] } } }))
            .toEqual([]);
    });
});
