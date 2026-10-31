import type { AgentEvent } from './AgentEvent.ts';

// The lines the claude CLI writes in stream-json mode. Only the fields the turn reads are typed.
interface CliTextBlock {
    type: 'text';
    text: string;
}

interface CliToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
}

// Other block kinds, such as thinking, carry nothing the turn shows.
interface CliOtherBlock {
    type: 'other';
}

type CliAssistantBlock = CliTextBlock | CliToolUseBlock | CliOtherBlock;

interface CliToolResultPart {
    type: 'text';
    text: string;
}

interface CliToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content?: string | (CliToolResultPart | CliOtherBlock)[] | undefined;
    is_error?: boolean | undefined;
}

type CliUserBlock = CliToolResultBlock | CliOtherBlock;

type CliMessage
    = | CliSystemMessage
        | CliStreamEventMessage
        | CliAssistantMessage
        | CliUserMessage
        | CliResultMessage
        | CliRateLimitMessage
        | { type: 'other' };

interface CliSystemMessage {
    type: 'system';
    subtype: string;
    session_id?: string | undefined;
}

interface CliStreamEventMessage {
    type: 'stream_event';
    event: { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } | { type: 'other' } } | { type: 'other' };
}

interface CliAssistantMessage {
    type: 'assistant';
    error?: string | undefined;
    message: { content: CliAssistantBlock[] };
}

interface CliUserMessage {
    type: 'user';
    message: { content: string | CliUserBlock[] };
}

interface CliSuccessResult {
    type: 'result';
    subtype: 'success';
    is_error: boolean;
    result: string;
    total_cost_usd: number;
    duration_ms: number;
    api_error_status?: number | null | undefined;
    // Sends the CLI still holds for a later result in the same process. An older CLI leaves it out.
    queued_turn_count?: number | undefined;
}

interface CliErrorResult {
    type: 'result';
    subtype: 'error_max_turns' | 'error_max_budget_usd' | 'error_during_execution';
    is_error: boolean;
    errors: string[];
    total_cost_usd: number;
    duration_ms: number;
}

type CliResultMessage = CliSuccessResult | CliErrorResult;

interface CliRateLimitMessage {
    type: 'rate_limit_event';
    rate_limit_info: { status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt?: number | undefined };
}

const MAX_TOOL_OUTPUT_LENGTH = 500;

// The CLI's own list of usage limit messages. A new wording from Anthropic can slip past it.
const USAGE_LIMIT_ERROR_PREFIXES: readonly string[] = [
    'You\'ve hit your',
    'You\'ve reached your',
    'You\'re out of usage credits',
    'Your org is out of usage · add funds to continue',
    'Your org is out of usage · contact your admin',
    'Your seat type doesn\'t include usage credits',
    'Your seat type doesn\'t include usage',
    'Your usage allocation has been disabled by your admin',
    'Your group\'s usage limit is set to $0',
    'Fable 5 requires usage credits',
    'You\'re out of extra usage',
    'Your seat type doesn\'t include extra usage',
];

function mapCliMessage(message: CliMessage): AgentEvent[] {
    switch (message.type) {
        case 'system':
            return message.subtype === 'init' && message.session_id !== undefined
                ? [{ type: 'session', sessionId: message.session_id }]
                : [];
        case 'stream_event':
            return mapStreamEvent(message);
        case 'assistant':
            return mapAssistantMessage(message);
        case 'user':
            return mapUserMessage(message);
        case 'result':
            return mapResultMessage(message);
        case 'rate_limit_event':
            return mapRateLimitInfo(message.rate_limit_info);
        default:
            return [];
    }
}

function mapStreamEvent(message: CliStreamEventMessage): AgentEvent[] {
    const { event } = message;

    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
        return [];
    }

    return [{ type: 'text_delta', text: event.delta.text }];
}

function mapAssistantMessage(message: CliAssistantMessage): AgentEvent[] {
    // An errored turn carries the error text as an assistant message. Skip it
    // here, because the result message reports the same failure once.
    if (message.error !== undefined) {
        return [];
    }

    const blockEvents = message.message.content.map(mapAssistantBlock);

    return blockEvents.flat();
}

function mapAssistantBlock(block: CliAssistantBlock): AgentEvent[] {
    switch (block.type) {
        case 'text':
            return [{ type: 'text', text: block.text }];
        case 'tool_use':
            return [{ type: 'tool_started', toolUseId: block.id, toolName: block.name, input: block.input }];
        default:
            return [];
    }
}

function mapUserMessage(message: CliUserMessage): AgentEvent[] {
    const content = message.message.content;

    if (typeof content === 'string') {
        return [];
    }

    const blockEvents = content.map(mapUserBlock);

    return blockEvents.flat();
}

function mapUserBlock(block: CliUserBlock): AgentEvent[] {
    if (block.type !== 'tool_result') {
        return [];
    }

    const output = summarizeToolResult(block.content);

    return [{ type: 'tool_finished', toolUseId: block.tool_use_id, isError: block.is_error === true, output }];
}

function summarizeToolResult(content: CliToolResultBlock['content']): string {
    const fullText = extractToolResultText(content);

    return fullText.slice(0, MAX_TOOL_OUTPUT_LENGTH);
}

function extractToolResultText(content: CliToolResultBlock['content']): string {
    if (typeof content === 'string') {
        return content;
    }

    if (content === undefined) {
        return '';
    }

    const textParts = content.flatMap(part => (part.type === 'text' ? [part.text] : []));

    return textParts.join('\n');
}

function mapResultMessage(message: CliResultMessage): AgentEvent[] {
    if (message.subtype === 'success' && !message.is_error) {
        return [{ type: 'turn_finished', costUsd: message.total_cost_usd, durationMs: message.duration_ms }];
    }

    // The CLI stops a turn at its step or spending limit and reports it as its own subtype, not as an error text.
    if (message.subtype === 'error_max_turns') {
        return [{ type: 'turn_limit', limit: 'steps' }];
    }

    if (message.subtype === 'error_max_budget_usd') {
        return [{ type: 'turn_limit', limit: 'spending' }];
    }

    // The result has no typed usage limit field. Usage limit errors show up
    // as text, so this matches the CLI's own list of usage limit messages.
    // Heuristic: a new wording from Anthropic can slip past it.
    const errorDetail = message.subtype === 'success' ? message.result : message.errors.join('\n');
    const errorText = errorDetail || 'The turn ended with an error.';

    // The CLI sets api_error_status to 429 on a limit. The text check is the fallback for results without it.
    const apiStatus = message.subtype === 'success' ? message.api_error_status : undefined;
    const isUsageLimit = apiStatus === 429 || isUsageLimitText(errorText);

    return [{ type: 'turn_error', message: errorText, isUsageLimit }];
}

// The CLI puts its API error line in front of the limit text, so that line is removed before the prefix check.
const CLI_RATE_LIMIT_PREFIX = /^API Error: Request rejected \(429\) · /;

function isUsageLimitText(text: string): boolean {
    const limitText = text.replace(CLI_RATE_LIMIT_PREFIX, '');

    return USAGE_LIMIT_ERROR_PREFIXES.some(prefix => limitText.startsWith(prefix));
}

function mapRateLimitInfo(rateLimitInfo: CliRateLimitMessage['rate_limit_info']): AgentEvent[] {
    // The CLI sends resetsAt in unix epoch seconds. Our events use milliseconds.
    const resetsAtOption = rateLimitInfo.resetsAt === undefined
        ? {}
        : { resetsAt: rateLimitInfo.resetsAt * 1000 };

    return [{ type: 'rate_limit', status: rateLimitInfo.status, ...resetsAtOption }];
}

function rememberResetsAt(agentEvent: AgentEvent, previousResetsAt: number | undefined): number | undefined {
    if (agentEvent.type === 'rate_limit' && agentEvent.resetsAt !== undefined) {
        return agentEvent.resetsAt;
    }

    return previousResetsAt;
}

function withResetsAt(agentEvent: AgentEvent, latestResetsAt: number | undefined): AgentEvent {
    if (agentEvent.type !== 'turn_error' || !agentEvent.isUsageLimit || latestResetsAt === undefined) {
        return agentEvent;
    }

    return { ...agentEvent, resetsAt: latestResetsAt };
}

export { USAGE_LIMIT_ERROR_PREFIXES, mapCliMessage, rememberResetsAt, withResetsAt };
export type { CliMessage };
