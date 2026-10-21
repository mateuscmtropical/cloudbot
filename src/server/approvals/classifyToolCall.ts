import type { ToolCall } from '../agent/AgentRunner.ts';

type ToolCallClass = 'skip' | 'always-ask' | 'review';

// Tools that only read, look or hand a result to the owner. They never need a review.
const SKIP_TOOL_NAMES = new Set([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'TodoWrite',
    'WebSearch',
    'mcp__cloudbot__browser_open',
    'mcp__cloudbot__browser_read',
    'mcp__cloudbot__browser_screenshot',
    'mcp__cloudbot__browser_scroll',
    'mcp__cloudbot__request_screen',
    'mcp__cloudbot__request_secret',
    'mcp__cloudbot__share_file',
    'mcp__cloudbot__update_profile',
]);

// The tools of the bot itself have fixed names. Any other tool is an outside connector.
const OWN_TOOL_PREFIX = 'mcp__cloudbot__';

// A word in a tool name that means a message goes out, money moves or a place is held.
const ALWAYS_ASK_WORDS = new Set([
    'send',
    'reply',
    'purchase',
    'buy',
    'pay',
    'checkout',
    'book',
    'booking',
    'reserve',
    'order',
]);

function splitIntoWords(toolName: string): string[] {
    const spaced = toolName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const words = spaced.toLowerCase()
        .split(/[^a-z0-9]+/);

    return words.filter(word => word !== '');
}

function classifyToolCall(call: ToolCall): ToolCallClass {
    if (SKIP_TOOL_NAMES.has(call.toolName)) {
        return 'skip';
    }

    // Built in tools and the bot's own tools are judged by the reviewer, which reads their input.
    if (!call.toolName.startsWith('mcp__') || call.toolName.startsWith(OWN_TOOL_PREFIX)) {
        return 'review';
    }

    const words = splitIntoWords(call.toolName);
    const isSensitive = words.some(word => ALWAYS_ASK_WORDS.has(word));

    return isSensitive ? 'always-ask' : 'review';
}

export { classifyToolCall };
export type { ToolCallClass };
