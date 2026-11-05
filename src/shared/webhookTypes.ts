// Why a call to a webhook was refused. The text is fixed, so no body, token or delivery id is ever shown.
type WebhookRefusalReason = 'rate limit' | 'queue full' | 'body too large' | 'not ready';

// One refused call, with the time it was refused. Kept in memory, so a restart forgets it.
interface WebhookRefusal {
    time: number;
    reason: WebhookRefusalReason;
}

// The name of a caller no known header or ?source= names.
const UNKNOWN_PROVIDER = 'unknown';
// The rule for any caller that has no rule of its own.
const ANY_PROVIDER = '*';

// Who called a webhook, as far as the request says. Anyone with the URL can claim any of this, so it proves nothing.
interface WebhookCaller {
    provider: string;
    event: string | undefined;
    address: string | undefined;
    userAgent: string | undefined;
}

// One call that reached the queue. Kept for 30 days.
interface WebhookCall extends WebhookCaller {
    time: number;
}

// What the owner wants done with the calls of one provider.
interface WebhookRule {
    provider: string;
    instruction: string;
}

// A webhook as the API lists it. The URL is never listed. The refusals and the calls are the last ones, newest first.
interface BotWebhook {
    id: string;
    name: string;
    createdAt: number;
    refusals: WebhookRefusal[];
    rules: WebhookRule[];
    calls: WebhookCall[];
}

// The create response. The URL is shown once, so the web app keeps it only until the owner hides it.
interface CreatedBotWebhook extends BotWebhook {
    url: string;
}

export { ANY_PROVIDER, UNKNOWN_PROVIDER };
export type { BotWebhook, CreatedBotWebhook, WebhookCall, WebhookCaller, WebhookRefusal, WebhookRefusalReason, WebhookRule };
