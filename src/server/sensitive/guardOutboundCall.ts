import { isOutboundCommand } from '../approvals/classifyToolCall.ts';
import { findSensitiveRefusal } from './sensitiveNumbers.ts';

const OWN_TOOL_PREFIX = 'mcp__cloudbot__';
// Own tools whose input leaves the bot: the browser, hand-offs, integrations, and text that is sent to a page or a schedule.
const OUTBOUND_BOT_TOOL_NAMES = new Set([
    `${OWN_TOOL_PREFIX}browser_type`,
    `${OWN_TOOL_PREFIX}desktop_type`,
    `${OWN_TOOL_PREFIX}browser_open`,
    `${OWN_TOOL_PREFIX}bot_send`,
    `${OWN_TOOL_PREFIX}integration_run`,
    `${OWN_TOOL_PREFIX}watch_create`,
    `${OWN_TOOL_PREFIX}bot_create`,
    `${OWN_TOOL_PREFIX}routine_create`,
]);
const OUTBOUND_BUILTIN_TOOL_NAMES = new Set(['WebFetch', 'WebSearch']);
// The GitHub CLI writes with issue, pr and similar commands, and with api, which can send any method.
const GITHUB_CLI_COMMAND_PATTERN = /\bgh\s+(?:issue|pr|release|gist|repo|label)\s+(?:create|comment|edit|close|reopen|merge|review|delete)\b|\bgh\s+api\b/i;

function readCommand(toolInput: unknown): string {
    const command = (toolInput as { command?: unknown } | null)?.command;

    return typeof command === 'string' ? command : '';
}

// Outside connectors send their input to another service, so every connector call counts as outbound.
// request_secret is not outbound, and the owner types its value into the secure form, not into a tool.
// Bash is best effort: only curl with a body, wget with post, mail commands and the gh writes are seen.
// Other ways to send data from a shell, such as python or nc, are not covered.
function isOutboundCall(toolName: string, toolInput: unknown): boolean {
    if (toolName === 'Bash') {
        const command = readCommand(toolInput);

        return isOutboundCommand(command) || GITHUB_CLI_COMMAND_PATTERN.test(command);
    }

    if (OUTBOUND_BOT_TOOL_NAMES.has(toolName) || OUTBOUND_BUILTIN_TOOL_NAMES.has(toolName)) {
        return true;
    }

    return toolName.startsWith('mcp__') && !toolName.startsWith(OWN_TOOL_PREFIX);
}

function serializeInput(toolInput: unknown): string {
    // JSON.stringify returns undefined for some inputs, such as undefined itself.
    const json = JSON.stringify(toolInput) as string | undefined;

    return json ?? '';
}

// Returns the refusal for an outbound call whose input holds a card, CPF or SSN number, or undefined when the call may run.
function findSensitiveOutboundRefusal(toolName: string, toolInput: unknown): string | undefined {
    if (!isOutboundCall(toolName, toolInput)) {
        return undefined;
    }

    const serializedInput = serializeInput(toolInput);

    return findSensitiveRefusal(serializedInput);
}

export { findSensitiveOutboundRefusal };
