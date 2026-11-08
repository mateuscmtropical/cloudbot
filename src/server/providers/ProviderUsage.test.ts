import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderUsage, describeProviderUsage, parseClaudeUsage, parseCodexRateLimits } from './ProviderUsage.ts';

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
