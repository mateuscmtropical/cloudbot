// Why a call to a webhook was refused. The text is fixed, so no body, token or delivery id is ever shown.
type WebhookRefusalReason = 'rate limit' | 'queue full' | 'body too large' | 'not ready';

// One refused call, with the time it was refused. Kept in memory, so a restart forgets it.
interface WebhookRefusal {
    time: number;
    reason: WebhookRefusalReason;
}

// A webhook as the API lists it. The URL is never listed. The refusals are the last ones, newest first.
interface BotWebhook {
    id: string;
    name: string;
    createdAt: number;
    refusals: WebhookRefusal[];
}

// The create response. The URL is shown once, so the web app keeps it only until the owner hides it.
interface CreatedBotWebhook extends BotWebhook {
    url: string;
}

export type { BotWebhook, CreatedBotWebhook, WebhookRefusal, WebhookRefusalReason };
