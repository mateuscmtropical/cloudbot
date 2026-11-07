import type { AppTriggerRecord, AppTriggerStore } from '../store/AppTriggerStore.ts';
import { buildTriggerMessage } from './triggerMessage.ts';
import { findTriggerSource } from './triggerSources.ts';
import type { SourceDeps } from './triggerSources.ts';

interface AppTriggerSchedulerOptions {
    triggerStore: AppTriggerStore;
    deps: SourceDeps;
    sendMessage: (botId: string, text: string) => Promise<unknown>;
    // Checks wait while this returns false, like routines do.
    isReady?: () => boolean;
    now?: () => number;
}

const CHECK_INTERVAL_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;
// More ids than a source lists at once, so an item that is still listed is never taken for a new one.
const MAX_SEEN = 100;

// Asks the app of each due trigger for its newest items. The first check only records them, so the owner is not
// woken for what was there before. A later check with new items sends one chat message. With none, no model runs.
class AppTriggerScheduler {
    private readonly options: AppTriggerSchedulerOptions;
    private readonly isReady: () => boolean;
    private readonly now: () => number;
    private timer: NodeJS.Timeout | undefined;
    private isChecking = false;

    constructor(options: AppTriggerSchedulerOptions) {
        this.options = options;
        this.isReady = options.isReady ?? (() => true);
        this.now = options.now ?? (() => Date.now());
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }

        const runCheck = (): void => {
            this.checkDueTriggers()
                .catch(() => {
                    console.error('Could not check the app triggers.');
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

    async checkDueTriggers(): Promise<void> {
        if (this.isChecking || !this.isReady()) {
            return;
        }

        this.isChecking = true;

        try {
            const nowMs = this.now();
            const due = await this.options.triggerStore.listDue(nowMs);

            const checks = due.map(trigger => this.checkTrigger(trigger, nowMs));

            await Promise.all(checks);
        } finally {
            this.isChecking = false;
        }
    }

    private async checkTrigger(trigger: AppTriggerRecord, nowMs: number): Promise<void> {
        try {
            await this.options.triggerStore.markChecked(trigger.id, nowMs, nowMs + trigger.intervalMinutes * MINUTE_MS);

            const source = findTriggerSource(trigger.source);

            if (source === undefined) {
                return;
            }

            const seen = trigger.seen === null ? undefined : new Set(trigger.seen);
            const result = await source.poll(trigger.target, seen, trigger.botId, this.options.deps);
            const newSeen = [...new Set([...result.ids, ...(trigger.seen ?? [])])].slice(0, MAX_SEEN);

            if (result.events.length > 0) {
                const message = buildTriggerMessage(trigger.name, source.label, trigger.prompt, result.events);

                // The ids are saved only after the message is queued. If the send fails, the next check sees the items again.
                await this.options.sendMessage(trigger.botId, message);
            }

            if (trigger.seen === null || result.events.length > 0) {
                await this.options.triggerStore.setSeen(trigger.id, newSeen);
            }
        } catch {
            // One failing trigger must not stop the others. The log names the trigger, not the app error.
            console.error(`Could not check the app trigger ${trigger.id}.`);
        }
    }
}

export { AppTriggerScheduler, CHECK_INTERVAL_MS };
export type { AppTriggerSchedulerOptions };
