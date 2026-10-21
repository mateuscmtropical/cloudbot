import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

const BOT_CREATE_TOOL_NAME = 'bot_create';
const BOT_CREATE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${BOT_CREATE_TOOL_NAME}`;
const NAME_MAX_LENGTH = 40;
const TITLE_MAX_LENGTH = 80;
const INSTRUCTIONS_MAX_LENGTH = 2000;
const DESCRIPTION = 'Create a new bot for the owner, with its own workspace, memory, rules and routines. Pass its name, its title and its first instructions. The owner approves the bot before it is made. The instructions become the new bot\'s memory file, not a permission. The new bot shares the Claude sign-in of this one, and it starts with no shared files and no secrets of yours.';

// A name or title on two lines would break the chat and the prompt, so both must be one line.
function hasLineBreak(text: string): boolean {
    return /[\r\n]/.test(text);
}

const BOT_CREATE_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(NAME_MAX_LENGTH)
        .refine(value => !hasLineBreak(value), 'The name must be one line.'),
    title: z.string()
        .trim()
        .min(1)
        .max(TITLE_MAX_LENGTH)
        .refine(value => !hasLineBreak(value), 'The title must be one line.'),
    instructions: z.string()
        .trim()
        .min(1)
        .max(INSTRUCTIONS_MAX_LENGTH),
};

interface BotCreateInput {
    name: string;
    title: string;
    instructions: string;
}

function textResult(text: string, isError: boolean): ProfileToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// What the handler returns about the bot it made. The name is shown back to the calling bot.
interface CreatedBot {
    name: string;
}

// The handler is the ChatService's. It makes the bot and writes the instructions to its memory file.
function createBotCreateTool(createBot: (input: BotCreateInput) => Promise<CreatedBot>): CloudbotTool {
    return tool(
        BOT_CREATE_TOOL_NAME,
        DESCRIPTION,
        BOT_CREATE_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const created = await createBot(args);

            return textResult(`Created the bot ${created.name}. The owner can open it from the bot list.`, false);
        },
    );
}

export { BOT_CREATE_TOOL_FULL_NAME, BOT_CREATE_SHAPE, createBotCreateTool };
export type { BotCreateInput, CreatedBot };
