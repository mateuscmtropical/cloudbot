interface TextDeltaEvent {
    type: 'text_delta';
    text: string;
}

interface TextEvent {
    type: 'text';
    text: string;
}

interface ToolStartedEvent {
    type: 'tool_started';
    toolUseId: string;
    toolName: string;
    input: unknown;
}

interface ToolFinishedEvent {
    type: 'tool_finished';
    toolUseId: string;
    isError: boolean;
    output: string;
}

interface SessionEvent {
    type: 'session';
    sessionId: string;
}

interface TurnFinishedEvent {
    type: 'turn_finished';
    costUsd?: number;
    durationMs?: number;
}

interface TurnErrorEvent {
    type: 'turn_error';
    message: string;
    isUsageLimit: boolean;
    resetsAt?: number;
}

interface RateLimitEvent {
    type: 'rate_limit';
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
}

// The SDK stopped the turn at the step limit or at the spending limit it was given.
interface TurnLimitEvent {
    type: 'turn_limit';
    limit: 'steps' | 'spending';
}

// The SDK sent a message that shows the turn is alive, such as tool progress or a retry. Nothing is shown or stored.
interface ActivityEvent {
    type: 'activity';
}

/**
 * Render either text_delta or text, never both. The text event arrives after
 * the text_delta events of the same block and repeats their content in full,
 * so showing both doubles the output.
 */
type AgentEvent
    = | TextDeltaEvent
        | TextEvent
        | ToolStartedEvent
        | ToolFinishedEvent
        | SessionEvent
        | TurnFinishedEvent
        | TurnErrorEvent
        | RateLimitEvent
        | TurnLimitEvent
        | ActivityEvent;

export type {
    AgentEvent,
    RateLimitEvent,
    SessionEvent,
    TextDeltaEvent,
    TextEvent,
    ToolFinishedEvent,
    ToolStartedEvent,
    TurnErrorEvent,
    TurnFinishedEvent,
    TurnLimitEvent,
};
