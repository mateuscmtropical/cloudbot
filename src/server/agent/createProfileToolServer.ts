import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { BotStore } from '../store/BotStore.ts';
import type { BotProfile } from '../store/types.ts';

// The server name is also the key in mcpServers, so the full tool name below depends on it.
const PROFILE_SERVER_NAME = 'cloudbot';
const UPDATE_PROFILE_TOOL_NAME = 'update_profile';
// The model calls the tool by this full name, and allowedTools needs it too.
const UPDATE_PROFILE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${UPDATE_PROFILE_TOOL_NAME}`;
const UPDATE_PROFILE_DESCRIPTION = 'Change this bot\'s name, title or description. Only the fields you pass change.';

// The limits keep a profile short enough to sit in the system prompt without crowding it.
const NAME_MAX_LENGTH = 40;
const TITLE_MAX_LENGTH = 80;
const DESCRIPTION_MAX_LENGTH = 500;

const PROFILE_TOOL_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(NAME_MAX_LENGTH)
        .optional(),
    title: z.string()
        .trim()
        .max(TITLE_MAX_LENGTH)
        .optional(),
    description: z.string()
        .trim()
        .max(DESCRIPTION_MAX_LENGTH)
        .optional(),
};

interface ProfileToolTextContent {
    type: 'text';
    text: string;
}

interface ProfileToolResult {
    [key: string]: unknown;
    content: ProfileToolTextContent[];
    isError?: boolean;
}

interface ProfileToolArguments {
    name: string | undefined;
    title: string | undefined;
    description: string | undefined;
}

function textResult(text: string, isError: boolean): ProfileToolResult {
    const textContent: ProfileToolTextContent = { type: 'text', text };

    return isError ? { content: [textContent], isError: true } : { content: [textContent] };
}

// Only the fields the model passed are included, so the other fields keep their values.
function buildChanges(args: ProfileToolArguments): Partial<BotProfile> {
    const nameChange = args.name === undefined ? {} : { name: args.name };
    const titleChange = args.title === undefined ? {} : { title: args.title };
    const descriptionChange = args.description === undefined ? {} : { description: args.description };

    return { ...nameChange, ...titleChange, ...descriptionChange };
}

// The bot id is fixed when the tool is built. The model cannot pick another bot.
function createUpdateProfileTool(botStore: BotStore, botId: string): SdkMcpToolDefinition<typeof PROFILE_TOOL_SHAPE> {
    return tool(
        UPDATE_PROFILE_TOOL_NAME,
        UPDATE_PROFILE_DESCRIPTION,
        PROFILE_TOOL_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const changes = buildChanges(args);
            const updatedBot = await botStore.updateProfile(botId, changes);

            if (updatedBot === undefined) {
                return textResult('This bot no longer exists, so its profile cannot change.', true);
            }

            return textResult(
                `Profile updated. Name: ${updatedBot.name}. Title: ${updatedBot.title}. Description: ${updatedBot.description}`,
                false,
            );
        },
    );
}

// The server is built for one turn and passed as mcpServers[PROFILE_SERVER_NAME].
function createProfileToolServer(botStore: BotStore, botId: string): McpSdkServerConfigWithInstance {
    const updateProfileTool = createUpdateProfileTool(botStore, botId);

    return createSdkMcpServer({
        name: PROFILE_SERVER_NAME,
        version: '1.0.0',
        tools: [updateProfileTool],
    });
}

export { PROFILE_SERVER_NAME, PROFILE_TOOL_SHAPE, UPDATE_PROFILE_TOOL_FULL_NAME, createProfileToolServer, createUpdateProfileTool };
export type { ProfileToolResult };
