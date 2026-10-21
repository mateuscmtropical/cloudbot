import { createHash } from 'node:crypto';

import type { WatchRecord, WatchStore } from '../store/WatchStore.ts';
import { filterLines, lineDiff } from './pageText.ts';
import { buildWatchMessage, capStoredText } from './watchMessage.ts';

interface WatchSchedulerOptions {
    watchStore: WatchStore;
    // Returns the visible text of the page. It throws when the page cannot be watched.
    fetchPage: (url: string) => Promise<string>;
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    // Checks wait while this returns false, like routines do.
    isReady?: () => boolean;
    now?: () => number;
}

const CHECK_INTERVAL_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;

function hashText(text: string): string {
    return createHash('sha256')
        .update(text)
        .digest('hex');
}

// The first check only records the page, so the owner is not woken for the page as it was before the watch.
// Later checks wake the bot only when the filtered text differs from the last one.
class WatchScheduler {
    private readonly watchStore: WatchStore;
    private readonly fetchPage: (url: string) => Promise<string>;
    private readonly sendMessage: (botId: string, text: string) => Promise<unknown>;
    private readonly isReady: () => boolean;
    private readonly now: () => number;
    private timer: NodeJS.Timeout | undefined;
    private isChecking = false;

    constructor(options: WatchSchedulerOptions) {
        this.watchStore = options.watchStore;
        this.fetchPage = options.fetchPage;
        this.sendMessage = options.sendMessage;
        this.isReady = options.isReady ?? (() => true);
        this.now = options.now ?? (() => Date.now());
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }

        const runCheck = (): void => {
            this.checkDueWatches()
                .catch(() => {
                    console.error('Could not check the watches.');
                });
        };

        this.timer = setInterval(runCheck, CHECK_INTERVAL_MS);
        this.timer.unref();
        runCheck();
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    async checkDueWatches(): Promise<void> {
        if (this.isChecking || !this.isReady()) {
            return;
        }

        this.isChecking = true;

        try {
            const nowMs = this.now();
            const dueWatches = await this.watchStore.listDue(nowMs);
            const checks = dueWatches.map(watch => this.checkWatch(watch, nowMs));

            await Promise.all(checks);
        } finally {
            this.isChecking = false;
        }
    }

    private async checkWatch(watch: WatchRecord, nowMs: number): Promise<void> {
        try {
            await this.watchStore.markChecked(watch.id, { checkedAt: nowMs, nextCheckAt: nowMs + watch.intervalMinutes * MINUTE_MS });

            const pageText = await this.fetchPage(watch.url);
            const text = filterLines(pageText, watch.keyword ?? undefined);
            const textHash = hashText(text);
            const storedText = capStoredText(text);

            if (watch.textHash === null) {
                await this.watchStore.setText(watch.id, { textHash, lastText: storedText });

                return;
            }

            if (textHash === watch.textHash) {
                return;
            }

            const diffLines = lineDiff(watch.lastText ?? '', storedText);
            const message = buildWatchMessage(watch.name, watch.url, diffLines);

            // The new text is saved only after the message is queued. If the send fails, the next check sees the change again.
            await this.sendMessage(watch.botId, message);
            await this.watchStore.setText(watch.id, { textHash, lastText: storedText });
        } catch {
            // One failing watch must not stop the others. The log names the watch, not its address.
            console.error(`Could not check the watch ${watch.id}.`);
        }
    }
}

export { CHECK_INTERVAL_MS, WatchScheduler };
export type { WatchSchedulerOptions };
