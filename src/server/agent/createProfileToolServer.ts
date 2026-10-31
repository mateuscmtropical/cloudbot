import { tool } from './cloudbotTool.ts';
import type { CloudbotTool } from './cloudbotTool.ts';
import { z } from 'zod/v4';

import { MASCOT_COLOR_NAMES, MASCOT_EYES, MASCOT_SHAPES } from '../../shared/mascot.ts';
import type { BotStore } from '../store/BotStore.ts';
import { ShareFileError } from '../files/shareFile.ts';
import type { BotProfile } from '../store/types.ts';

// The server name is also the key in mcpServers, so the full tool name below depends on it.
const PROFILE_SERVER_NAME = 'cloudbot';
const UPDATE_PROFILE_TOOL_NAME = 'update_profile';
const SET_MASCOT_TOOL_NAME = 'profile_set_mascot';
const SET_MASCOT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SET_MASCOT_TOOL_NAME}`;
const SET_MASCOT_DESCRIPTION = `Change this bot's mascot, the cloud the owner sees next to its name. Pass a color, one of ${MASCOT_COLOR_NAMES.join(', ')}, a shape, one of ${MASCOT_SHAPES.join(', ')}, or eyes, one of ${MASCOT_EYES.join(', ')}. The eyes are the face it shows at rest. Only the fields you pass change.`;

const SET_MASCOT_TOOL_SHAPE = {
    color: z.enum(MASCOT_COLOR_NAMES)
        .optional(),
    shape: z.enum(MASCOT_SHAPES)
        .optional(),
    eyes: z.enum(MASCOT_EYES)
        .optional(),
};
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

// A name is shown in chat and in bot hand-off framing, so control characters such as a newline are refused.
const NAME_CONTROL_PATTERN = /\p{Cc}/u;

const PROFILE_TOOL_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(NAME_MAX_LENGTH)
        .refine(value => !NAME_CONTROL_PATTERN.test(value), 'The name must be one line of plain text.')
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

// Gives the reason a new name cannot be used, such as a channel that already has a member with it. Undefined means the name is free.
type NameConflictCheck = (name: string) => Promise<string | undefined>;

// The bot id is fixed when the tool is built. The model cannot pick another bot.
function createUpdateProfileTool(botStore: BotStore, botId: string, nameConflict?: NameConflictCheck): CloudbotTool<typeof PROFILE_TOOL_SHAPE> {
    return tool(
        UPDATE_PROFILE_TOOL_NAME,
        UPDATE_PROFILE_DESCRIPTION,
        PROFILE_TOOL_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const changes = buildChanges(args);
            const conflict = changes.name === undefined || nameConflict === undefined ? undefined : await nameConflict(changes.name);

            if (conflict !== undefined) {
                return textResult(conflict, true);
            }

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

// The bot id is fixed when the tool is built, as for update_profile. Only the mascot fields change.
function createSetMascotTool(botStore: BotStore, botId: string): CloudbotTool<typeof SET_MASCOT_TOOL_SHAPE> {
    return tool(
        SET_MASCOT_TOOL_NAME,
        SET_MASCOT_DESCRIPTION,
        SET_MASCOT_TOOL_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            if (args.color === undefined && args.shape === undefined && args.eyes === undefined) {
                return textResult('Pass a color, a shape, eyes or several. Nothing changed.', true);
            }

            const changes = {
                ...(args.color === undefined ? {} : { color: args.color }),
                ...(args.shape === undefined ? {} : { shape: args.shape }),
                ...(args.eyes === undefined ? {} : { eyes: args.eyes }),
            };
            const updatedBot = await botStore.updateMascot(botId, changes);

            if (updatedBot === undefined) {
                return textResult('This bot no longer exists, so its mascot cannot change.', true);
            }

            return textResult(`Mascot updated. Color: ${updatedBot.mascotColor}. Shape: ${updatedBot.mascotShape}. Eyes: ${updatedBot.mascotEyes}.`, false);
        },
    );
}

function createShareFileTool(shareFile: ShareFileHandler): CloudbotTool<typeof SHARE_FILE_TOOL_SHAPE> {
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

// The tools of one turn. The share_file tool is added only when a handler is given. Extra tools, such as the browser tools, join the same list.
function createProfileTools(
    botStore: BotStore,
    botId: string,
    shareFile?: ShareFileHandler,
    extraTools: CloudbotTool[] = [],
    nameConflict?: NameConflictCheck,
): CloudbotTool[] {
    const updateProfileTool = createUpdateProfileTool(botStore, botId, nameConflict);
    const setMascotTool = createSetMascotTool(botStore, botId);
    const shareTools = shareFile === undefined ? [] : [createShareFileTool(shareFile)];

    return [updateProfileTool, setMascotTool, ...shareTools, ...extraTools];
}

export {
    PROFILE_SERVER_NAME,
    PROFILE_TOOL_SHAPE,
    SET_MASCOT_TOOL_FULL_NAME,
    SET_MASCOT_TOOL_SHAPE,
    SHARE_FILE_TOOL_FULL_NAME,
    SHARE_FILE_TOOL_SHAPE,
    UPDATE_PROFILE_TOOL_FULL_NAME,
    createProfileTools,
    createSetMascotTool,
    createShareFileTool,
    createUpdateProfileTool,
};
export type { CloudbotTool, NameConflictCheck, ProfileToolResult, ShareFileHandler };
