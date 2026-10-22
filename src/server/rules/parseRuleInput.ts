import type { NewBotRule } from '../store/RuleStore.ts';

interface RuleInputError {
    error: string;
}

const MAX_RULE_TEXT_LENGTH = 300;
const MAX_BLOCKED_TOOLS = 20;
// A tool name as the SDK spells it, such as Bash, WebFetch or mcp__cloudbot__browser_open,
// optionally with a pattern in parentheses, such as Bash(rm:*).
// The SDK joins the list with commas, so a pattern cannot hold one.
const TOOL_RULE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,99}(\([^(),\n]{1,200}\))?$/;

// The same check the owner's rule tool makes. No registry of tool names exists, so the format is what is checked.
function isToolRuleName(name: string): boolean {
    return TOOL_RULE_PATTERN.test(name);
}

function readField(input: unknown, field: string): unknown {
    return typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;
}

function parseBlockedTools(rawTools: unknown): string[] | RuleInputError {
    if (rawTools === undefined) {
        return [];
    }

    if (!Array.isArray(rawTools) || rawTools.length > MAX_BLOCKED_TOOLS) {
        return { error: `Send blockedTools as a list of at most ${String(MAX_BLOCKED_TOOLS)} tool names.` };
    }

    const toolNames = rawTools.map(toolName => (typeof toolName === 'string' ? toolName.trim() : ''));
    const isEveryNameValid = toolNames.every(toolName => TOOL_RULE_PATTERN.test(toolName));

    if (!isEveryNameValid) {
        return { error: 'Each blocked tool is a tool name such as Bash or WebFetch, optionally with a pattern such as Bash(rm:*).' };
    }

    return [...new Set(toolNames)];
}

// Checks a rule from the owner. Only block rules may name tools, because an allow rule
// must not widen what the bot can do beyond the tools it already has.
function parseRuleInput(input: unknown): NewBotRule | RuleInputError {
    const kind = readField(input, 'kind');
    const rawText = readField(input, 'text');

    if (kind !== 'allow' && kind !== 'block') {
        return { error: 'Send kind as "allow" or "block".' };
    }

    const collapsedText = typeof rawText === 'string' ? rawText.replaceAll(/\s+/g, ' ') : '';
    const text = collapsedText.trim();

    if (text === '' || text.length > MAX_RULE_TEXT_LENGTH) {
        return { error: `Send the rule as text of 1 to ${String(MAX_RULE_TEXT_LENGTH)} characters.` };
    }

    const rawTools = readField(input, 'blockedTools');
    const blockedTools = parseBlockedTools(rawTools);

    if (!Array.isArray(blockedTools)) {
        return blockedTools;
    }

    if (kind === 'allow' && blockedTools.length > 0) {
        return { error: 'Only a block rule can name tools.' };
    }

    return { kind, text, blockedTools };
}

function isRuleInputError(value: NewBotRule | RuleInputError): value is RuleInputError {
    return 'error' in value;
}

export { MAX_BLOCKED_TOOLS, MAX_RULE_TEXT_LENGTH, isRuleInputError, isToolRuleName, parseRuleInput };
export type { RuleInputError };
