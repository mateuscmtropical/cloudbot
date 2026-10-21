// A page watch as the API lists it. The stored hash and the last text are never listed.
interface BotWatch {
    id: string;
    name: string;
    url: string;
    intervalMinutes: number;
    keyword: string | null;
    lastCheckedAt: number | null;
    nextCheckAt: number;
    createdAt: number;
}

export type { BotWatch };
