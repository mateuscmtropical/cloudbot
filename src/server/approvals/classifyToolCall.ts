import type { ToolCall } from '../agent/AgentRunner.ts';
import { EMAIL_SEND_TOOL_FULL_NAME, EMAIL_SETUP_TOOL_FULL_NAME } from '../email/emailToolNames.ts';

type ToolCallClass = 'skip' | 'always-ask' | 'review';

// Tools that only read, look, hand a result to the owner or edit the bot's own profile, which the owner asks for in the chat. They never need a review.
const SKIP_TOOL_NAMES = new Set([
    'Read',
    'Glob',
    'Grep',
    'LS',
    'TodoWrite',
    'WebSearch',
    // Handing work to a helper does nothing by itself. Each tool call the helper makes is reviewed on its own.
    'Agent',
    'mcp__cloudbot__browser_open',
    'mcp__cloudbot__browser_read',
    'mcp__cloudbot__browser_screenshot',
    'mcp__cloudbot__browser_scroll',
    'mcp__cloudbot__request_screen',
    // Recording hands the screen to the owner, who does the task. Reading the recording only reads those steps.
    'mcp__cloudbot__screen_record',
    'mcp__cloudbot__screen_recording',
    'mcp__cloudbot__routine_list',
    'mcp__cloudbot__webhook_list',
    'mcp__cloudbot__watch_list',
    'mcp__cloudbot__request_secret',
    'mcp__cloudbot__share_file',
    'mcp__cloudbot__update_profile',
    'mcp__cloudbot__profile_set_mascot',
    'mcp__cloudbot__browser_allowed_hosts',
    'mcp__cloudbot__browser_remove_host',
    'mcp__cloudbot__app_list',
    'mcp__cloudbot__app_remove',
    'mcp__cloudbot__integration_list',
    'mcp__cloudbot__rule_list',
    // Skills are text the owner already approved, so listing and reading them needs no review.
    'mcp__cloudbot__skill_list',
    'mcp__cloudbot__skill_read',
    'mcp__cloudbot__channel_list',
    // The board is the bot's own notes. Moving a task to Blocked tells the owner in the chat, so the move needs no review.
    'mcp__cloudbot__task_add',
    'mcp__cloudbot__task_move',
    'mcp__cloudbot__task_board',
    // The export only shares a copy of the bot's template in the chat, so it needs no review.
    'mcp__cloudbot__bot_export',
    // Listing reads the public gallery and changes nothing, so it needs no review.
    'mcp__cloudbot__gallery_list',
    'mcp__cloudbot__screen_show',
    // It only posts a card. The browser asks the owner for permission after the owner taps the button.
    'mcp__cloudbot__notifications_enable',
    // The same: it posts a card, and the browser removes its own subscription when the owner taps.
    'mcp__cloudbot__notifications_disable',
    // Listing only reads the names. Adding and removing post a card, and the browser acts only when the owner taps it.
    'mcp__cloudbot__passkey_add',
    'mcp__cloudbot__passkey_list',
    'mcp__cloudbot__passkey_remove',
    // Listing reads the provider status. Connecting only posts the provider list, and the owner signs in on the provider's page.
    'mcp__cloudbot__provider_list',
    'mcp__cloudbot__provider_connect',
    'mcp__cloudbot__email_status',
    // These only link or unlink a number and post secure forms. No WhatsApp message is ever sent.
    'mcp__cloudbot__whatsapp_connect',
    'mcp__cloudbot__whatsapp_disconnect',
]);

// Letting the browser reach a private host always needs the owner's approval, whatever the rules say.
// A new outside server, and the tools it brings, always need the owner's approval too.
const ALWAYS_ASK_TOOL_NAMES = new Set([
    // These calls have fixed cards, so an owner always sees the exact mail or mailbox settings.
    EMAIL_SEND_TOOL_FULL_NAME,
    EMAIL_SETUP_TOOL_FULL_NAME,
    'mcp__cloudbot__browser_allow_host',
    'mcp__cloudbot__app_connect',
    // A new bot gets its own workspace and its first instructions, so the owner approves it before it is made.
    'mcp__cloudbot__bot_create',
    // An imported template or instruction draft can make a bot, so the owner approves it first.
    'mcp__cloudbot__bot_import',
    // Pasted instructions become a bot's memory, so the owner approves the whole draft first.
    'mcp__cloudbot__bot_import_text',
    // A gallery template becomes a bot, and a share opens a pull request to a public repository. Each waits for the owner's card.
    'mcp__cloudbot__gallery_install',
    'mcp__cloudbot__gallery_share',
    // A new or changed script runs with a secret, so the owner approves the file that is registered.
    'mcp__cloudbot__integration_create',
    'mcp__cloudbot__integration_update',
    // Rules are permissions, and a deleted bot is gone for good, so the owner approves both in the chat.
    'mcp__cloudbot__rule_change',
    'mcp__cloudbot__bot_delete',
    // A skill is steps the bot will follow, so the owner reads and approves the whole text, and each removal.
    'mcp__cloudbot__skill_add',
    'mcp__cloudbot__skill_remove',
    // A new channel, a new member and a new manager change who takes part, so the owner approves each one.
    'mcp__cloudbot__channel_create',
    'mcp__cloudbot__channel_add',
    'mcp__cloudbot__channel_set_manager',
    // Removing a member or deleting a channel changes who takes part, and deletes its messages, so the owner approves each one.
    'mcp__cloudbot__channel_remove',
    'mcp__cloudbot__channel_delete',
    // Limits decide how much a turn may spend, so the owner approves each change with its old and new values.
    'mcp__cloudbot__limits_set',
    // A new provider gets the bot's next messages and files, so the owner approves the switch.
    'mcp__cloudbot__provider_use',
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
// Short words such as pay, book and order stay out, because payload and bookmark start with them.
const ALWAYS_ASK_STEMS = ['send', 'reply', 'publish', 'tweet', 'email', 'purchase', 'charge', 'transfer', 'checkout', 'reserve'];

const MAIL_COMMAND_PATTERN = /\b(sendmail|mailx?|msmtp|ssmtp|swaks)\b/i;
const CURL_COMMAND_PATTERN = /\bcurl\b/i;
// Flags that send a body or change the method, also inside combined short flags such as -sd.
const CURL_BODY_FLAG_PATTERN = /\s-[a-zA-Z]*[dFTX]|\s--(data|form|upload-file|json|request)/;
const WGET_COMMAND_PATTERN = /\bwget\b/i;
const WGET_POST_FLAG_PATTERN = /\s--(post|method)/;
// The patterns above are linear, but a very long command is not worth scanning and goes to the owner.
const MAX_SCANNED_COMMAND_LENGTH = 10_000;

function isOutboundCommand(command: string): boolean {
    if (command.length > MAX_SCANNED_COMMAND_LENGTH) {
        return true;
    }

    const isCurlWithBody = CURL_COMMAND_PATTERN.test(command) && CURL_BODY_FLAG_PATTERN.test(command);

    const isWgetPost = WGET_COMMAND_PATTERN.test(command) && WGET_POST_FLAG_PATTERN.test(command);

    return isCurlWithBody || isWgetPost || MAIL_COMMAND_PATTERN.test(command);
}

function splitIntoWords(toolName: string): string[] {
    const spaced = toolName.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
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
    if (ALWAYS_ASK_TOOL_NAMES.has(call.toolName)) {
        return 'always-ask';
    }

    if (SKIP_TOOL_NAMES.has(call.toolName)) {
        return 'skip';
    }

    const command = readCommand(call.input);

    if (call.toolName === 'Bash' && isOutboundCommand(command)) {
        return 'always-ask';
    }

    // Built in tools and the bot's own tools are judged by the reviewer, which reads their input.
    if (!call.toolName.startsWith('mcp__') || call.toolName.startsWith(OWN_TOOL_PREFIX)) {
        return 'review';
    }

    // The server segment names a product, such as postgres or bookstack, and says nothing about what the tool does.
    const toolSegment = call.toolName.split('__')
        .slice(2)
        .join('__');
    const words = splitIntoWords(toolSegment);
    const isSensitive = words.some(isSensitiveWord);

    return isSensitive ? 'always-ask' : 'review';
}

export { classifyToolCall, isOutboundCommand };
export type { ToolCallClass };
