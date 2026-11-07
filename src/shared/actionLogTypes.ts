// What happened to a tool call. allowed ran on its own, owner_approved and owner_denied were answered on a card,
// blocked was stopped by the block list, refused by the review agent, and not_answered timed out or was stopped.
type ActionDecision = 'allowed' | 'owner_approved' | 'owner_denied' | 'blocked' | 'refused' | 'not_answered' | 'review_failed';

// One action of a bot. Names, outcomes and the short card line, so the log never holds a tool input, a reply or chat text.
interface ActionLogEntry {
    botId: string;
    event: 'review' | 'tool_finished' | 'turn_error';
    tool?: string | undefined;
    decision?: ActionDecision | undefined;
    // Who decided: the owner, a person of a shared group with the role, the review agent or the block list.
    decidedBy?: string | undefined;
    // The one line the card or the review gave for the call, and the reason for a refusal. Both are cut short.
    summary?: string | undefined;
    reason?: string | undefined;
    // Set when the call came from a channel turn.
    channelId?: string | undefined;
    durationMs?: number | undefined;
    isError?: boolean | undefined;
}

// An entry as the log keeps it, with the time as ISO text.
interface ActionLogRecord extends ActionLogEntry {
    at: string;
}

export type { ActionDecision, ActionLogEntry, ActionLogRecord };
