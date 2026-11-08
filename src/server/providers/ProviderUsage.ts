import type { ProviderUsageSummary, ProviderUsageWindow } from '../../shared/providerTypes.ts';
import { PROVIDER_LABELS } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

// Reads one provider's plan usage through its own CLI. An empty list means the CLI gave no usage.
type UsageSource = () => Promise<ProviderUsageWindow[]>;

// Asking a CLI can take several seconds, and a page and the bot's tool may ask close together.
const USAGE_FRESH_MS = 60_000;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const MAX_RESET_TEXT = 80;

// One line of the Claude Code `/usage` text, such as "Current session: 25% used · resets Nov 7, 11pm (America/Sao_Paulo)".
// Checked against claude 2.1.319. The reset time is local text, so it stays text. A new wording makes the line drop out,
// and a provider with no matching line shows as not available.
const CLAUDE_USAGE_LINE = /^Current ([^:]+):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$/;

function capitalize(text: string): string {
    const first = text.charAt(0);
    const rest = text.slice(1);

    return first.toUpperCase() + rest;
}

function parseClaudeUsage(text: string): ProviderUsageWindow[] {
    return text.split('\n')
        .map(line => line.trim())
        .map(line => CLAUDE_USAGE_LINE.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map(match => ({
            label: capitalize(match[1] ?? ''),
            usedPercent: Number(match[2]),
            resetsAt: null,
            resetsText: match[3] === undefined ? null : match[3].slice(0, MAX_RESET_TEXT),
        }));
}

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function describeWindowLength(minutes: number | null): string {
    if (minutes === null || minutes <= 0) {
        return 'Limit';
    }

    if (minutes === MINUTES_PER_DAY * 7) {
        return 'Weekly limit';
    }

    if (minutes % MINUTES_PER_DAY === 0) {
        return `${String(minutes / MINUTES_PER_DAY)} day limit`;
    }

    if (minutes % MINUTES_PER_HOUR === 0) {
        return `${String(minutes / MINUTES_PER_HOUR)} hour limit`;
    }

    return `${String(minutes)} minute limit`;
}

function readCodexWindow(value: unknown, prefix: string): ProviderUsageWindow | undefined {
    const window = readRecord(value);

    if (typeof window.usedPercent !== 'number') {
        return undefined;
    }

    const minutes = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null;
    // Codex sends the reset in epoch seconds.
    const resetsAt = typeof window.resetsAt === 'number' ? window.resetsAt * 1000 : null;

    return { label: `${prefix}${describeWindowLength(minutes)}`, usedPercent: window.usedPercent, resetsAt, resetsText: null };
}

// Reads the answer of `account/rateLimits/read` (codex-cli 0.166.0). A model with its own quota has its own bucket,
// so the buckets are named when there are several.
function parseCodexRateLimits(result: unknown): ProviderUsageWindow[] {
    const answer = readRecord(result);
    const bucketsById = readRecord(answer.rateLimitsByLimitId);
    const buckets = Object.values(bucketsById);
    const snapshots = buckets.length > 0 ? buckets : [answer.rateLimits];
    const isSeveral = snapshots.length > 1;

    return snapshots.flatMap((snapshot) => {
        const record = readRecord(snapshot);
        const name = record.limitName ?? record.limitId;
        const prefix = isSeveral && typeof name === 'string' ? `${name}: ` : '';
        const windows = [readCodexWindow(record.primary, prefix), readCodexWindow(record.secondary, prefix)];

        return windows.filter((window): window is ProviderUsageWindow => window !== undefined);
    });
}

function readNumber(value: unknown): number | undefined {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

    return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function readTime(value: unknown): number | null {
    const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;

    return Number.isFinite(time) ? time : null;
}

function toUsedPercent(percent: number): number {
    const atLeastZero = Math.max(0, percent);
    const kept = Math.min(100, atLeastZero);

    return Math.round(kept * 10) / 10;
}

const COPILOT_SNAPSHOTS = [['premium_interactions', 'Premium requests'], ['chat', 'Chat'], ['completions', 'Completions']] as const;

// Reads the body of `GET https://api.github.com/copilot_internal/user`, the call the Copilot CLI makes (@github/copilot
// 1.0.12, checked in its app.js). A snapshot that is unlimited has nothing to show. All snapshots reset on the same day.
function parseCopilotUsage(body: unknown): ProviderUsageWindow[] {
    const answer = readRecord(body);
    const snapshots = readRecord(answer.quota_snapshots);
    const resetsAt = readTime(answer.quota_reset_date_utc) ?? readTime(answer.quota_reset_date);

    return COPILOT_SNAPSHOTS.flatMap(([key, label]) => {
        const snapshot = readRecord(snapshots[key]);
        const remaining = readNumber(snapshot.percent_remaining);

        if (snapshot.unlimited === true || snapshot.entitlement === -1 || remaining === undefined) {
            return [];
        }

        return [{ label, usedPercent: toUsedPercent(100 - remaining), resetsAt, resetsText: null }];
    });
}

const KIMI_LIMITS = [['limit_5h', '5 hour limit'], ['limit_7d', 'Weekly limit'], ['limit_month_total', 'Monthly limit']] as const;

// Reads the body of `GET https://api.kimi.com/coding/v1/usages`, the call behind `/usage` in Kimi Code 2.5.2. The ratio
// is a share from 0 to 1, as a number or a numeric string.
function parseKimiUsage(body: unknown): ProviderUsageWindow[] {
    const usages = readRecord(readRecord(body).usages);

    return KIMI_LIMITS.flatMap(([key, label]) => {
        const entry = readRecord(usages[key]);
        const ratio = readNumber(entry.used_ratio);

        return ratio === undefined ? [] : [{ label, usedPercent: toUsedPercent(ratio * 100), resetsAt: readTime(entry.reset_time), resetsText: null }];
    });
}

const AGY_WINDOW_LABELS: Record<string, string> = { 'weekly': 'Weekly limit', '5h': '5 hour limit' };

// Reads the JSON of `agy -p "/usage" --output-format json` (agy 1.5.3). It is a read-only command of print mode, so it
// spends no tokens. Each group of models shares its limits, so the group is named in front of each limit.
function parseAgyUsage(body: unknown): ProviderUsageWindow[] {
    const data = readRecord(readRecord(readRecord(body).command).data);
    const groups: unknown[] = Array.isArray(data.groups) ? data.groups : [];

    return groups.flatMap((group) => {
        const groupRecord = readRecord(group);
        const buckets: unknown[] = Array.isArray(groupRecord.buckets) ? groupRecord.buckets : [];
        const prefix = typeof groupRecord.name === 'string' ? `${groupRecord.name}: ` : '';

        return buckets.flatMap((bucket) => {
            const record = readRecord(bucket);
            const remaining = readNumber(record.remaining_fraction);
            const window = typeof record.window === 'string' ? AGY_WINDOW_LABELS[record.window] : undefined;
            const name = window ?? (typeof record.name === 'string' ? record.name : 'Limit');

            return remaining === undefined ? [] : [{ label: `${prefix}${name}`, usedPercent: toUsedPercent((1 - remaining) * 100), resetsAt: readTime(record.reset_time), resetsText: null }];
        });
    });
}

// Keeps the last usage of each provider for a short time. A provider with no source, or a source that fails,
// shows as not available. A failure is not kept, so the next ask tries again.
class ProviderUsage {
    private readonly kept = new Map<ProviderId, { at: number; windows: Promise<ProviderUsageWindow[]> }>();

    constructor(private readonly sources: Partial<Record<ProviderId, UsageSource>>) {}

    read(providers: ProviderId[]): Promise<ProviderUsageSummary[]> {
        const summaries = providers.map(async (provider) => {
            const windows = await this.windowsOf(provider);

            return { provider, label: PROVIDER_LABELS[provider], windows };
        });

        return Promise.all(summaries);
    }

    private windowsOf(provider: ProviderId): Promise<ProviderUsageWindow[]> {
        const source = this.sources[provider];

        if (source === undefined) {
            return Promise.resolve([]);
        }

        const kept = this.kept.get(provider);

        if (kept !== undefined && Date.now() - kept.at < USAGE_FRESH_MS) {
            return kept.windows;
        }

        const windows = source()
            .catch(() => {
                // The CLI could not answer, for example while signed out. The caller shows "not available".
                this.kept.delete(provider);

                return [];
            });

        this.kept.set(provider, { at: Date.now(), windows });

        return windows;
    }
}

// The text the bot reads, and the same words the web page shows.
function describeProviderUsage(summaries: ProviderUsageSummary[]): string {
    if (summaries.length === 0) {
        return 'No provider is connected.';
    }

    const lines = summaries.map((summary) => {
        if (summary.windows.length === 0) {
            return `${summary.label}: not available for this provider.`;
        }

        const windows = summary.windows.map((window) => {
            const resetsAtDate = window.resetsAt === null ? undefined : new Date(window.resetsAt);
            const resets = resetsAtDate?.toISOString() ?? window.resetsText;

            return `${window.label} ${String(window.usedPercent)}% used${resets === null ? '' : `, resets ${resets}`}`;
        });

        return `${summary.label}: ${windows.join('. ')}.`;
    });

    return lines.join('\n');
}

export { ProviderUsage, describeProviderUsage, parseAgyUsage, parseClaudeUsage, parseCodexRateLimits, parseCopilotUsage, parseKimiUsage };
export type { UsageSource };
