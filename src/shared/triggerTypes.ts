// An app trigger as the API lists it. The seen ids are never listed. Times are milliseconds since the epoch.
interface BotTrigger {
    id: string;
    name: string;
    source: string;
    // The name of the app source, such as "Gmail".
    sourceLabel: string;
    target: string;
    // The owner's instruction for each new item.
    prompt: string;
    intervalMinutes: number;
    isEnabled: boolean;
    lastCheckedAt: number | null;
    nextCheckAt: number;
    createdAt: number;
}

export type { BotTrigger };
