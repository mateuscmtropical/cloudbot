import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { textResult } from './createBotTool.ts';

const BOT_SEND_TOOL_NAME = 'bot_send';
const BOT_SEND_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${BOT_SEND_TOOL_NAME}`;
const TARGET_MAX_LENGTH = 40;
const TEXT_MAX_LENGTH = 4000;
const DESCRIPTION = 'Send a message or a task to another bot of the owner, found by its name. That bot works on it as a new turn, under its own rules and approvals, and its reply comes back to this chat. The owner sees the hand-off in both chats. A chain allows 3 hand-offs in a row.';

const BOT_SEND_SHAPE = {
    bot: z.string()
        .trim()
        .min(1)
        .max(TARGET_MAX_LENGTH),
    text: z.string()
        .trim()
        .min(1)
        .max(TEXT_MAX_LENGTH),
};

interface BotSendInput {
    bot: string;
    text: string;
}

// The text the calling bot gets back. An error means the hand-off was not sent.
interface BotSendOutcome {
    isError: boolean;
    text: string;
}

// The handler is the ChatService's. It checks the target and the chain depth, then starts the target's turn.
function createBotSendTool(sendToBot: (input: BotSendInput) => Promise<BotSendOutcome>): CloudbotTool {
    return tool(
        BOT_SEND_TOOL_NAME,
        DESCRIPTION,
        BOT_SEND_SHAPE,
        (args): Promise<ProfileToolResult> => sendToBot(args)
            .then(outcome => textResult(outcome.text, outcome.isError)),
    );
}

export { BOT_SEND_TOOL_FULL_NAME, BOT_SEND_SHAPE, createBotSendTool };
export type { BotSendInput, BotSendOutcome };
