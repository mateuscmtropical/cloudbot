import type { AgentEvent } from './AgentEvent.ts';
import { unwrapShellCommand } from './answerCodexRequest.ts';
import { isAgentMessageItem, isCommandItem, isFileChangeItem, isImageGenerationItem, isMcpToolCallItem } from './codexProtocol.ts';
import type { CodexThreadItem, CodexTurn } from './codexProtocol.ts';

const USAGE_LIMIT_INFO = 'usageLimitExceeded';
const TURN_FAILED_MESSAGE = 'The Codex turn failed.';

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// The item of an item/started or item/completed notification. Its kind decides how it is read.
function readItem(params: unknown): CodexThreadItem | undefined {
    const item = readRecord(params).item;
    const record = readRecord(item);

    return typeof record.type === 'string' ? item as CodexThreadItem : undefined;
}

function startedEvents(item: CodexThreadItem): AgentEvent[] {
    if (isCommandItem(item)) {
        const command = unwrapShellCommand(item.command);

        return [{ type: 'tool_started', toolUseId: item.id, toolName: 'Bash', input: { command } }];
    }

    if (isFileChangeItem(item)) {
        const paths = item.changes.map(change => change.path);

        return [{ type: 'tool_started', toolUseId: item.id, toolName: 'Edit', input: { files: paths } }];
    }

    if (isMcpToolCallItem(item)) {
        return [{ type: 'tool_started', toolUseId: item.id, toolName: `mcp__${item.server}__${item.tool}`, input: item.arguments }];
    }

    return [{ type: 'activity' }];
}

function completedEvents(item: CodexThreadItem): AgentEvent[] {
    if (isAgentMessageItem(item)) {
        return [{ type: 'text', text: item.text }];
    }

    if (isCommandItem(item)) {
        const isError = item.status !== 'completed' || (item.exitCode ?? 0) !== 0;

        return [{ type: 'tool_finished', toolUseId: item.id, isError, output: item.aggregatedOutput ?? item.status }];
    }

    if (isFileChangeItem(item) || isMcpToolCallItem(item)) {
        return [{ type: 'tool_finished', toolUseId: item.id, isError: item.status !== 'completed', output: item.status }];
    }

    // The image is only in this item. Without it the model says it made an image and the owner sees none.
    if (isImageGenerationItem(item) && item.result !== undefined && item.result !== '') {
        return [{ type: 'image', data: item.result }];
    }

    return [{ type: 'activity' }];
}

// The events of one Codex notification. A notification that shows nothing still shows the turn is alive.
// The end of the turn is read by mapCodexTurnEnd, since the engine also ends the process then.
function mapCodexNotification(method: string, params: unknown): AgentEvent[] {
    if (method === 'item/agentMessage/delta') {
        const delta = readRecord(params).delta;

        return typeof delta === 'string' ? [{ type: 'text_delta', text: delta }] : [{ type: 'activity' }];
    }

    const item = method === 'item/started' || method === 'item/completed' ? readItem(params) : undefined;

    if (item === undefined) {
        return [{ type: 'activity' }];
    }

    return method === 'item/started' ? startedEvents(item) : completedEvents(item);
}

// The input tokens of the last model call, from the usage notification Codex sends after each call. The total of the turn
// adds up every call, so it would overstate the context.
function readContextTokens(method: string, params: unknown): number | undefined {
    if (method !== 'thread/tokenUsage/updated') {
        return undefined;
    }

    const inputTokens = readRecord(readRecord(readRecord(params).tokenUsage).last).inputTokens;

    return typeof inputTokens === 'number' ? inputTokens : undefined;
}

// A stopped turn ends with nothing, as a stop of the Claude engine does. A failed one names a usage limit when Codex says so.
// Codex puts the reset time only in the message text, so no reset time is read here.
function mapCodexTurnEnd(turn: CodexTurn, contextTokens?: number): AgentEvent[] {
    if (turn.status === 'completed') {
        const durationOption = turn.durationMs === null ? {} : { durationMs: turn.durationMs };
        const contextOption = contextTokens === undefined ? {} : { contextTokens };

        return [{ type: 'turn_finished', ...durationOption, ...contextOption }];
    }

    if (turn.status === 'interrupted') {
        return [];
    }

    const isUsageLimit = turn.error?.codexErrorInfo === USAGE_LIMIT_INFO;

    return [{ type: 'turn_error', message: turn.error?.message ?? TURN_FAILED_MESSAGE, isUsageLimit }];
}

export { mapCodexNotification, mapCodexTurnEnd, readContextTokens, readItem };
