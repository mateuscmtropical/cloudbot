import { tool } from '@anthropic-ai/claude-agent-sdk';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

const BOT_DELETE_TOOL_NAME = 'bot_delete';
const BOT_DELETE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${BOT_DELETE_TOOL_NAME}`;
const DESCRIPTION = 'Delete this bot and everything of it, when the owner asks for it in the chat. The owner approves the deletion first. The last bot cannot be deleted. Its chat ends with this turn.';

// The handler is the ChatService's. It starts the delete after this turn, since the delete stops this turn.
function createBotDeleteTool(deleteSelf: () => Promise<string>): CloudbotTool {
    return tool(
        BOT_DELETE_TOOL_NAME,
        DESCRIPTION,
        {},
        async (): Promise<ProfileToolResult> => {
            const message = await deleteSelf();

            return { content: [{ type: 'text' as const, text: message }] };
        },
    );
}

export { BOT_DELETE_TOOL_FULL_NAME, createBotDeleteTool };
