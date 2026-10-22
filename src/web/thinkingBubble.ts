import type { ChatMessage } from '../shared/chatTypes.ts';
import { findFailureState } from './mascotState.ts';

// The lines the bubble cycles through while the bot works without a tool.
const THINKING_LINES = ['Thinking', 'Mulling it over', 'Checking a few things'];
// How long each line stays before the next one.
const LINE_INTERVAL_MS = 4000;
// The bubble waits this long before it shows. A turn that ends right after its final text shows nothing.
const BUBBLE_DELAY_MS = 300;
// The line for a tool with no phrase of its own below. It is also used when the name is not known.
const FALLBACK_TOOL_PHRASE = 'Working on it';

// Tool names as the CLI and the bot's own tool server spell them, in plain words.
const TOOL_PHRASES = new Map<string, string>([
    ['Bash', 'Running a command'],
    ['PowerShell', 'Running a command'],
    ['WebFetch', 'Reading a web page'],
    ['WebSearch', 'Searching the web'],
    ['Read', 'Reading a file'],
    ['Write', 'Making a file'],
    ['Edit', 'Changing a file'],
    ['MultiEdit', 'Changing a file'],
    ['Glob', 'Looking through files'],
    ['Grep', 'Looking through files'],
    ['ToolSearch', 'Looking up its tools'],
    ['mcp__cloudbot__browser_open', 'Opening a page'],
    ['mcp__cloudbot__browser_read', 'Reading a page'],
    ['mcp__cloudbot__browser_screenshot', 'Taking a screenshot'],
    ['mcp__cloudbot__browser_scroll', 'Scrolling a page'],
    ['mcp__cloudbot__share_file', 'Sharing a file'],
]);

// The line for the thinking phrase at this count. The count wraps around the list.
function thinkingLineAt(count: number): string {
    return THINKING_LINES[count % THINKING_LINES.length] ?? 'Thinking';
}

function toolPhrase(toolName: string): string {
    return TOOL_PHRASES.get(toolName) ?? FALLBACK_TOOL_PHRASE;
}

// A question that holds a tool call until the owner answers, and has no answer yet.
function isPendingApproval(message: ChatMessage): boolean {
    return message.body.kind === 'choice' && message.body.isApproval === true && message.body.chosenId === undefined;
}

// A form or code field the owner has not sent yet.
function isUnsubmittedField(message: ChatMessage): boolean {
    return (message.body.kind === 'secureForm' || message.body.kind === 'codeField') && !message.body.submitted;
}

// The bot waits on the owner when a field is open after the owner's last message. Older fields, such as ones from
// before a restart, do not count.
function isWaitingOnOwnerField(messages: ChatMessage[]): boolean {
    const lastUserIndex = messages.reduce((found, message, index) => (message.role === 'user' ? index : found), -1);

    const laterMessages = messages.slice(lastUserIndex + 1);

    return laterMessages.some(isUnsubmittedField);
}

// The bubble shows while a turn runs and no reply is streaming. It hides when the chat shows a question for the owner,
// a field the owner must fill, or a usage limit wait.
function isThinkingBubbleShown(input: { isRunning: boolean; draftText: string; messages: ChatMessage[] }): boolean {
    return input.isRunning
        && input.draftText === ''
        && !input.messages.some(isPendingApproval)
        && !isWaitingOnOwnerField(input.messages)
        && findFailureState(input.messages) !== 'sleepy';
}

// Tool rows are not shown in the chat, except a failed one, which the owner should see. The bubble is the only sign of
// a working tool.
function withoutToolRows(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(message => message.body.kind !== 'toolActivity' || message.body.status === 'error');
}

export { BUBBLE_DELAY_MS, FALLBACK_TOOL_PHRASE, LINE_INTERVAL_MS, THINKING_LINES, isThinkingBubbleShown, thinkingLineAt, toolPhrase, withoutToolRows };
