import type { WebhookRefusal, WebhookRefusalReason } from '../../shared/webhookTypes.ts';

const MAX_REFUSALS_PER_WEBHOOK = 20;
const MAX_DELIVERY_IDS_PER_WEBHOOK = 1000;
const DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

interface WebhookMemoryOptions {
    now?: () => number;
}

// The last refused calls of each webhook, newest first when listed. Kept in memory only, so a restart forgets them.
// The reason is a fixed text, so the body, the token and the delivery id never reach this log.
class WebhookRefusalLog {
    private readonly entries = new Map<string, WebhookRefusal[]>();
    private readonly now: () => number;

    constructor(options: WebhookMemoryOptions = {}) {
        this.now = options.now ?? (() => Date.now());
    }

    record(webhookId: string, reason: WebhookRefusalReason): void {
        const refusal: WebhookRefusal = { time: this.now(), reason };
        const current = this.entries.get(webhookId) ?? [];
        const kept = [...current, refusal].slice(-MAX_REFUSALS_PER_WEBHOOK);

        this.entries.set(webhookId, kept);
    }

    list(webhookId: string): WebhookRefusal[] {
        return [...(this.entries.get(webhookId) ?? [])].reverse();
    }

    // Drops the refused calls of a webhook that was deleted.
    forget(webhookId: string): void {
        this.entries.delete(webhookId);
    }
}

// The delivery ids a webhook was queued with, for 24 hours. Old ids are dropped when a webhook is used again,
// and at most 1000 are kept per webhook, the oldest going first. A restart forgets them.
class DeliveryMemory {
    private readonly deliveries = new Map<string, Map<string, number>>();
    // The ids of calls that are being handled now. They count as duplicates until they are remembered or released.
    private readonly reserved = new Map<string, Set<string>>();
    private readonly now: () => number;

    constructor(options: WebhookMemoryOptions = {}) {
        this.now = options.now ?? (() => Date.now());
    }

    isRemembered(webhookId: string, deliveryId: string): boolean {
        const fresh = this.prune(webhookId);

        return fresh.has(deliveryId);
    }

    // Takes the id for a call that is being handled. False when the id is remembered or already taken.
    // The check and the take are one step, before any await, so two calls with one id cannot both pass.
    reserve(webhookId: string, deliveryId: string): boolean {
        const isRemembered = this.isRemembered(webhookId, deliveryId);
        const taken = this.reservedIds(webhookId);

        if (isRemembered || taken.has(deliveryId)) {
            return false;
        }

        taken.add(deliveryId);

        return true;
    }

    // Gives the id back when the call was refused, so the same id can be sent again.
    release(webhookId: string, deliveryId: string): void {
        this.reservedIds(webhookId)
            .delete(deliveryId);
    }

    // Called only after the message was queued, so a refused call can be sent again with the same id.
    remember(webhookId: string, deliveryId: string): void {
        const fresh = this.prune(webhookId);

        this.release(webhookId, deliveryId);

        const queuedAt = this.now();

        fresh.delete(deliveryId);
        fresh.set(deliveryId, queuedAt);

        const excess = Math.max(0, fresh.size - MAX_DELIVERY_IDS_PER_WEBHOOK);
        const freshIds = [...fresh.keys()];
        const oldestIds = freshIds.slice(0, excess);

        oldestIds.forEach((oldId) => {
            fresh.delete(oldId);
        });
    }

    // Drops the ids of a webhook that was deleted.
    forget(webhookId: string): void {
        this.deliveries.delete(webhookId);
        this.reserved.delete(webhookId);
    }

    private reservedIds(webhookId: string): Set<string> {
        const existing = this.reserved.get(webhookId);

        if (existing !== undefined) {
            return existing;
        }

        const created = new Set<string>();

        this.reserved.set(webhookId, created);

        return created;
    }

    // Keeps the ids of the last 24 hours only, and stores the result back.
    private prune(webhookId: string): Map<string, number> {
        const cutoff = this.now() - DELIVERY_WINDOW_MS;
        const times = this.deliveries.get(webhookId) ?? new Map<string, number>();
        const recentEntries = [...times].filter(([, queuedAt]) => queuedAt > cutoff);
        const fresh = new Map(recentEntries);

        this.deliveries.set(webhookId, fresh);

        return fresh;
    }
}

export { DELIVERY_WINDOW_MS, DeliveryMemory, MAX_DELIVERY_IDS_PER_WEBHOOK, MAX_REFUSALS_PER_WEBHOOK, WebhookRefusalLog };
