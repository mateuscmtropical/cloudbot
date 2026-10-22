import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { CHANNEL_NAME_MAX_LENGTH } from '../store/ChannelStore.ts';
import { MAX_MEMBERS_PER_CALL, addMember, createChannel, deleteChannel, listChannels, removeMember, setManager } from './channelCommands.ts';
import type { ChannelCommandDeps, ChannelCommandResult } from './channelCommands.ts';

const CHANNEL_CREATE_TOOL_NAME = 'channel_create';
const CHANNEL_LIST_TOOL_NAME = 'channel_list';
const CHANNEL_ADD_TOOL_NAME = 'channel_add';
const CHANNEL_SET_MANAGER_TOOL_NAME = 'channel_set_manager';
const CHANNEL_REMOVE_TOOL_NAME = 'channel_remove';
const CHANNEL_DELETE_TOOL_NAME = 'channel_delete';

// The model calls each tool by its full name, and the allowed list and the review use the same names.
const fullName = (toolName: string): string => `mcp__${PROFILE_SERVER_NAME}__${toolName}`;

const CHANNEL_CREATE_TOOL_FULL_NAME = fullName(CHANNEL_CREATE_TOOL_NAME);
const CHANNEL_LIST_TOOL_FULL_NAME = fullName(CHANNEL_LIST_TOOL_NAME);
const CHANNEL_ADD_TOOL_FULL_NAME = fullName(CHANNEL_ADD_TOOL_NAME);
const CHANNEL_SET_MANAGER_TOOL_FULL_NAME = fullName(CHANNEL_SET_MANAGER_TOOL_NAME);
const CHANNEL_REMOVE_TOOL_FULL_NAME = fullName(CHANNEL_REMOVE_TOOL_NAME);
const CHANNEL_DELETE_TOOL_FULL_NAME = fullName(CHANNEL_DELETE_TOOL_NAME);

// Only the full names that a bot can call. Every change waits for the owner in the review. Listing does not.
const CHANNEL_TOOL_FULL_NAMES = [
    CHANNEL_CREATE_TOOL_FULL_NAME,
    CHANNEL_LIST_TOOL_FULL_NAME,
    CHANNEL_ADD_TOOL_FULL_NAME,
    CHANNEL_SET_MANAGER_TOOL_FULL_NAME,
    CHANNEL_REMOVE_TOOL_FULL_NAME,
    CHANNEL_DELETE_TOOL_FULL_NAME,
];

const NAME_SHAPE = z.string()
    .trim()
    .min(1)
    .max(CHANNEL_NAME_MAX_LENGTH)
    .refine(value => !/[\r\n]/.test(value), 'A name must be one line.');

const MEMBER_NAME_SHAPE = z.string()
    .trim()
    .min(1);

const CHANNEL_CREATE_SHAPE = {
    name: NAME_SHAPE,
    members: z.array(MEMBER_NAME_SHAPE)
        .max(MAX_MEMBERS_PER_CALL)
        .optional(),
};

const CHANNEL_NAMED_SHAPE = {
    channel: z.string()
        .trim()
        .min(1),
    bot: z.string()
        .trim()
        .min(1),
};

const CHANNEL_ONLY_SHAPE = {
    channel: z.string()
        .trim()
        .min(1),
};

function toResult(result: ChannelCommandResult): ProfileToolResult {
    const content = { type: 'text' as const, text: result.text };

    return result.isError ? { content: [content], isError: true } : { content: [content] };
}

// The tools of one bot. The caller is the bot that makes the call, so it becomes the manager of a channel it creates.
function createChannelTools(deps: ChannelCommandDeps, callerBotId: string): CloudbotTool[] {
    return [
        tool(
            CHANNEL_CREATE_TOOL_NAME,
            'Create a channel, a group chat for a project. This bot becomes its manager. Pass a name and the names of the bots to add, which are the other bots of the owner. The owner approves the channel before it is made. Each bot in it keeps its own rules.',
            CHANNEL_CREATE_SHAPE,
            async (args): Promise<ProfileToolResult> => toResult(await createChannel(deps, callerBotId, { name: args.name, memberNames: args.members ?? [] })),
        ),
        tool(
            CHANNEL_LIST_TOOL_NAME,
            'List the channels this bot is in, with their members. The manager is marked.',
            {},
            async (): Promise<ProfileToolResult> => toResult(await listChannels(deps, callerBotId)),
        ),
        tool(
            CHANNEL_ADD_TOOL_NAME,
            'Add a bot to a channel. Only the manager of the channel can add a bot. Pass the channel name and the bot name. The owner approves it first.',
            CHANNEL_NAMED_SHAPE,
            async (args): Promise<ProfileToolResult> => toResult(await addMember(deps, args, callerBotId)),
        ),
        tool(
            CHANNEL_SET_MANAGER_TOOL_NAME,
            'Make a member the manager of a channel. Only the current manager can do it. The manager splits the owner\'s requests in the channel. Pass the channel name and the bot name. The owner approves it first.',
            CHANNEL_NAMED_SHAPE,
            async (args): Promise<ProfileToolResult> => toResult(await setManager(deps, args, callerBotId)),
        ),
        tool(
            CHANNEL_REMOVE_TOOL_NAME,
            'Remove a member from a channel. The owner approves it first. The manager cannot leave until another member is the manager.',
            CHANNEL_NAMED_SHAPE,
            async (args): Promise<ProfileToolResult> => toResult(await removeMember(deps, args)),
        ),
        tool(
            CHANNEL_DELETE_TOOL_NAME,
            'Delete a channel and all of its messages. The owner approves it first.',
            CHANNEL_ONLY_SHAPE,
            async (args): Promise<ProfileToolResult> => toResult(await deleteChannel(deps, args)),
        ),
    ];
}

export {
    CHANNEL_ADD_TOOL_FULL_NAME,
    CHANNEL_CREATE_TOOL_FULL_NAME,
    CHANNEL_DELETE_TOOL_FULL_NAME,
    CHANNEL_LIST_TOOL_FULL_NAME,
    CHANNEL_REMOVE_TOOL_FULL_NAME,
    CHANNEL_SET_MANAGER_TOOL_FULL_NAME,
    CHANNEL_TOOL_FULL_NAMES,
    createChannelTools,
};
