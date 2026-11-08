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

export { ProviderUsage, describeProviderUsage, parseClaudeUsage, parseCodexRateLimits };
export type { UsageSource };
