// A webhook as the API lists it. The URL is never listed.
interface BotWebhook {
    id: string;
    name: string;
    createdAt: number;
}

// The create response. The URL is shown once, so the web app keeps it only until the owner hides it.
interface CreatedBotWebhook extends BotWebhook {
    url: string;
}

export type { BotWebhook, CreatedBotWebhook };
