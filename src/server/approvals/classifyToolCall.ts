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
    'post',
    'publish',
    'tweet',
    'email',
    'purchase',
    'buy',
    'pay',
    'charge',
    'transfer',
    'checkout',
    'book',
    'booking',
    'reserve',
    'order',
]);

// Stems that also catch one word names such as sendmessage or plurals such as sends.
const ALWAYS_ASK_STEMS = ['send', 'reply', 'publish', 'tweet', 'purchase', 'checkout'];

// A shell command that sends data out or mails. The reviewer model cannot be trusted alone for these.
const OUTBOUND_COMMAND_PATTERN = /\b(sendmail|mailx?|msmtp|ssmtp|swaks)\b|\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|-F|-T)\b|--data|--form|--upload-file|--json)|\bwget\b[^|;&]*--(post|method)/i;

function splitIntoWords(toolName: string): string[] {
    const spaced = toolName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    const words = spaced.toLowerCase()
        .split(/[^a-z0-9]+/);

    return words.filter(word => word !== '');
}

function readCommand(input: unknown): string {
    const command = (input as { command?: unknown } | null)?.command;

    return typeof command === 'string' ? command : '';
}

function isSensitiveWord(word: string): boolean {
    const singular = word.endsWith('s') ? word.slice(0, -1) : word;
    const isKnownWord = ALWAYS_ASK_WORDS.has(word) || ALWAYS_ASK_WORDS.has(singular);

    return isKnownWord || ALWAYS_ASK_STEMS.some(stem => word.startsWith(stem));
}

function classifyToolCall(call: ToolCall): ToolCallClass {
    if (SKIP_TOOL_NAMES.has(call.toolName)) {
        return 'skip';
    }

    const command = readCommand(call.input);

    if (call.toolName === 'Bash' && OUTBOUND_COMMAND_PATTERN.test(command)) {
        return 'always-ask';
    }

    // Built in tools and the bot's own tools are judged by the reviewer, which reads their input.
    if (!call.toolName.startsWith('mcp__') || call.toolName.startsWith(OWN_TOOL_PREFIX)) {
        return 'review';
    }

    const words = splitIntoWords(call.toolName);
    const isSensitive = words.some(isSensitiveWord);

    return isSensitive ? 'always-ask' : 'review';
}

export { classifyToolCall };
export type { ToolCallClass };
