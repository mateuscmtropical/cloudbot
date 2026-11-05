// One action of a bot, for debugging. Only names and outcomes, so the log never holds a tool input, a reply or chat text.
interface ActionLogEntry {
    botId: string;
    event: 'review' | 'tool_finished' | 'turn_error';
    tool?: string | undefined;
    decision?: 'allowed' | 'refused' | 'owner_denied' | 'review_failed' | undefined;
    durationMs?: number | undefined;
    isError?: boolean | undefined;
}

// An entry as the log keeps it, with the time as ISO text.
interface ActionLogRecord extends ActionLogEntry {
    at: string;
}

export type { ActionLogEntry, ActionLogRecord };
