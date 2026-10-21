import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { BotStore } from '../store/BotStore.ts';
import { ShareFileError } from '../files/shareFile.ts';
import type { BotProfile } from '../store/types.ts';

// The server name is also the key in mcpServers, so the full tool name below depends on it.
const PROFILE_SERVER_NAME = 'cloudbot';
const UPDATE_PROFILE_TOOL_NAME = 'update_profile';
// The model calls the tool by this full name, and allowedTools needs it too.
const UPDATE_PROFILE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${UPDATE_PROFILE_TOOL_NAME}`;
const SHARE_FILE_TOOL_NAME = 'share_file';
const SHARE_FILE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SHARE_FILE_TOOL_NAME}`;
const SHARE_FILE_DESCRIPTION = 'Send a file from your workspace to the owner in the chat, as a download. Pass the path of the file, relative to your workspace or absolute inside it. Only regular files inside your workspace can be shared.';
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

const SHARE_FILE_TOOL_SHAPE = {
    path: z.string()
        .trim()
        .min(1),
};

// Copies the file and posts it to the chat. It throws ShareFileError with a message for the model.
type ShareFileHandler = (path: string) => Promise<{ name: string; sizeBytes: number }>;

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

function createShareFileTool(shareFile: ShareFileHandler): SdkMcpToolDefinition<typeof SHARE_FILE_TOOL_SHAPE> {
    return tool(
        SHARE_FILE_TOOL_NAME,
        SHARE_FILE_DESCRIPTION,
        SHARE_FILE_TOOL_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            try {
                const shared = await shareFile(args.path);

                return textResult(`Shared ${shared.name} (${String(shared.sizeBytes)} bytes) in the chat.`, false);
            } catch (error: unknown) {
                if (error instanceof ShareFileError) {
                    return textResult(error.message, true);
                }

                return textResult('The file could not be shared.', true);
            }
        },
    );
}

// The server is built for one turn and passed as mcpServers[PROFILE_SERVER_NAME].
// The share_file tool is added only when a handler is given.
function createProfileToolServer(botStore: BotStore, botId: string, shareFile?: ShareFileHandler): McpSdkServerConfigWithInstance {
    const updateProfileTool = createUpdateProfileTool(botStore, botId);
    const shareTools = shareFile === undefined ? [] : [createShareFileTool(shareFile)];

    return createSdkMcpServer({
        name: PROFILE_SERVER_NAME,
        version: '1.0.0',
        tools: [updateProfileTool, ...shareTools],
    });
}

export {
    PROFILE_SERVER_NAME,
    PROFILE_TOOL_SHAPE,
    SHARE_FILE_TOOL_FULL_NAME,
    SHARE_FILE_TOOL_SHAPE,
    UPDATE_PROFILE_TOOL_FULL_NAME,
    createProfileToolServer,
    createShareFileTool,
    createUpdateProfileTool,
};
export type { ProfileToolResult, ShareFileHandler };
