import type { ChannelSettings } from '../../shared/channelTypes.ts';
import type { BotStore } from '../store/BotStore.ts';
import { ChannelError } from '../store/ChannelStore.ts';
import type { Channel, ChannelStore } from '../store/ChannelStore.ts';
import type { Bot } from '../store/types.ts';

interface ChannelCommandDeps {
    channels: ChannelStore;
    bots: BotStore;
    // Runs after a member leaves, so the bot's queued and running channel turns can end with it.
    memberLeft?: ((channelId: string, botId: string) => Promise<void>) | undefined;
    // Runs before a channel is deleted, so its rounds stop before their messages go.
    channelDeleting?: ((channelId: string) => Promise<void>) | undefined;
}

// What a channel tool returns to the calling bot. An error is shown to the model as a failed call.
interface ChannelCommandResult {
    text: string;
    isError: boolean;
}

// A bot or channel name that the tool call resolves, or the reason it does not.
type Resolved<T> = { value: T } | { error: string };

const MAX_MEMBERS_PER_CALL = 20;

function done(text: string): ChannelCommandResult {
    return { text, isError: false };
}

function failed(text: string): ChannelCommandResult {
    return { text, isError: true };
}

// Bot names are not unique, so a name that matches two bots is refused rather than guessed.
async function resolveBot(bots: BotStore, name: string): Promise<Resolved<Bot>> {
    const wanted = name.trim()
        .toLowerCase();
    const matches = (await bots.list()).filter(bot => bot.name.toLowerCase() === wanted);
    const [only] = matches;

    if (only === undefined) {
        return { error: `No bot is named ${name.trim()}.` };
    }

    if (matches.length > 1) {
        return { error: `More than one bot is named ${name.trim()}. Rename one of them first.` };
    }

    return { value: only };
}

async function resolveChannel(channels: ChannelStore, name: string): Promise<Resolved<Channel>> {
    const channel = await channels.findByName(name);

    return channel === undefined ? { error: `No channel is named ${name.trim()}.` } : { value: channel };
}

// Resolves several bot names. The first name that does not resolve stops the call with its reason.
async function resolveBots(bots: BotStore, names: string[]): Promise<Resolved<Bot[]>> {
    const lookups = names.map(name => resolveBot(bots, name));
    const results = await Promise.all(lookups);
    const failures = results.filter((result): result is { error: string } => 'error' in result);
    const [firstFailure] = failures;

    if (firstFailure !== undefined) {
        return firstFailure;
    }

    const resolved = results.filter((result): result is { value: Bot } => 'value' in result)
        .map(result => result.value);

    return { value: resolved };
}

// A roster line for the calling bot, with the manager marked. Names come from the current bot list.
function describeChannel(channel: Channel, namesById: Map<string, string>): string {
    const memberLines = channel.members.map((member) => {
        const name = namesById.get(member.botId) ?? 'a bot that was deleted';

        return member.isManager ? `${name} (manager)` : name;
    });

    return `${channel.name}: ${memberLines.join(', ')}`;
}

async function namesById(bots: BotStore): Promise<Map<string, string>> {
    const list = await bots.list();
    const entries = list.map((bot): [string, string] => [bot.id, bot.name]);

    return new Map(entries);
}

function isMember(channel: Channel, botId: string): boolean {
    return channel.members.some(member => member.botId === botId);
}

function isManager(channel: Channel, botId: string): boolean {
    return channel.members.some(member => member.botId === botId && member.isManager);
}

// A bot cannot take a name that another member of one of its channels already has, since names route the turns.
// Returns the reason with the first channel that would clash, or undefined when the name is free.
function findNameClash(channels: Channel[], bots: Bot[], botId: string, name: string): string | undefined {
    const nameEntries = bots.map((bot): [string, string] => [bot.id, bot.name]);
    const namesById = new Map(nameEntries);
    const wanted = name.trim()
        .toLowerCase();
    const clashingChannels = channels.flatMap((channel) => {
        const isMemberHere = isMember(channel, botId);
        const hasClash = channel.members.some(member => member.botId !== botId && namesById.get(member.botId)
            ?.toLowerCase() === wanted);

        return isMemberHere && hasClash ? [channel.name] : [];
    });
    const [clashingChannel] = clashingChannels;

    return clashingChannel === undefined
        ? undefined
        : `${name.trim()} is already the name of a member of ${clashingChannel}. Pick another name.`;
}

// The bots this one can message outside a channel round. A member of an isolated channel reaches only the members of its
// isolated channels, and any other bot reaches every bot that is in none. This limits messages only. All the bots of a
// person run as one system user, so it is not a security boundary.
function reachableBots(bots: Bot[], channels: Channel[], botId: string): Bot[] {
    const isolated = channels.filter(channel => channel.isIsolated);
    const own = isolated.filter(channel => isMember(channel, botId));
    const isolatedIds = isolated.flatMap(channel => channel.members.map(member => member.botId));
    const walledOff = new Set(isolatedIds);
    const mateIds = own.flatMap(channel => channel.members.map(member => member.botId));
    const mates = new Set(mateIds);

    return bots.filter(bot => bot.id !== botId && (own.length > 0 ? mates.has(bot.id) : !walledOff.has(bot.id)));
}

// Why the owner's settings cannot be used, or undefined. Names route the turns, so two members cannot share one.
async function findSettingsProblem(bots: BotStore, settings: ChannelSettings): Promise<string | undefined> {
    const allBots = await bots.list();
    const members = allBots.filter(bot => settings.memberIds.includes(bot.id));
    const lowerNames = members.map(bot => bot.name.toLowerCase());
    const uniqueIds = new Set(settings.memberIds);
    const uniqueNames = new Set(lowerNames);

    if (settings.memberIds.length > MAX_MEMBERS_PER_CALL) {
        return `A channel takes at most ${String(MAX_MEMBERS_PER_CALL)} members.`;
    }

    if (members.length !== uniqueIds.size) {
        return 'One of the bots no longer exists.';
    }

    if (uniqueNames.size !== lowerNames.length) {
        return 'Two members of a channel cannot share a name. Rename one of them first.';
    }

    return uniqueIds.has(settings.managerId) ? undefined : 'The manager must be one of the channel members.';
}

// The owner makes a channel in the web app. The ids come from the bot picker, since bot names are not unique.
async function createOwnerChannel(deps: ChannelCommandDeps, settings: ChannelSettings): Promise<Resolved<Channel>> {
    const problem = await findSettingsProblem(deps.bots, settings);

    if (problem !== undefined) {
        return { error: problem };
    }

    const memberIds = [...new Set(settings.memberIds)];

    try {
        const channel = await deps.channels.create({ ...settings, memberIds });

        return { value: channel };
    } catch (error) {
        if (error instanceof ChannelError) {
            return { error: error.message };
        }

        throw error;
    }
}

// The owner changes a channel. Everything is checked first, and a new manager takes over before the old one can leave.
// Returns the reason it was refused.
async function updateOwnerChannel(deps: ChannelCommandDeps, channel: Channel, settings: ChannelSettings): Promise<string | undefined> {
    const problem = await findSettingsProblem(deps.bots, settings);

    if (problem !== undefined) {
        return problem;
    }

    const uniqueIds = new Set(settings.memberIds);

    try {
        await deps.channels.rename(channel.id, settings.name);
    } catch (error) {
        if (error instanceof ChannelError) {
            return error.message;
        }

        throw error;
    }

    const currentIds = channel.members.map(member => member.botId);
    const added = [...uniqueIds].filter(botId => !currentIds.includes(botId));
    const removed = currentIds.filter(botId => !uniqueIds.has(botId));
    const additions = added.map(botId => deps.channels.addMember(channel.id, botId));

    await Promise.all(additions);
    await deps.channels.setManager(channel.id, settings.managerId);

    const removals = removed.map(async (botId) => {
        await deps.channels.removeMember(channel.id, botId);
        await deps.memberLeft?.(channel.id, botId);
    });

    await Promise.all(removals);
    await deps.channels.setIsolated(channel.id, settings.isIsolated);

    return undefined;
}

// Makes a channel with the calling bot as its manager. The owner approves the call before it runs.
async function createChannel(deps: ChannelCommandDeps, callerBotId: string, input: { name: string; memberNames: string[] }): Promise<ChannelCommandResult> {
    if (input.memberNames.length > MAX_MEMBERS_PER_CALL) {
        return failed(`A channel takes at most ${String(MAX_MEMBERS_PER_CALL)} members in one call.`);
    }

    const members = await resolveBots(deps.bots, input.memberNames);

    if ('error' in members) {
        return failed(members.error);
    }

    const memberIds = [...new Set([callerBotId, ...members.value.map(bot => bot.id)])];

    try {
        const channel = await deps.channels.create({ name: input.name, managerId: callerBotId, memberIds });

        return done(`Created the channel ${channel.name}. Its manager is this bot.`);
    } catch (error) {
        if (error instanceof ChannelError) {
            return failed(error.message);
        }

        throw error;
    }
}

// Lists the channels this bot is in. A channel it is not in stays hidden from it.
async function listChannels(deps: ChannelCommandDeps, callerBotId: string): Promise<ChannelCommandResult> {
    const channels = (await deps.channels.list()).filter(channel => isMember(channel, callerBotId));

    if (channels.length === 0) {
        return done('This bot is not in any channel.');
    }

    const names = await namesById(deps.bots);

    const lines = channels.map(channel => describeChannel(channel, names));
    const text = lines.join('\n');

    return done(text);
}

// Adds a bot to a channel. Only the channel's manager adds members. The bot has its own rules, so it still checks each request it gets.
async function addMember(deps: ChannelCommandDeps, input: { channel: string; bot: string }, callerBotId: string): Promise<ChannelCommandResult> {
    const channel = await resolveChannel(deps.channels, input.channel);
    const bot = await resolveBot(deps.bots, input.bot);

    if ('error' in channel) {
        return failed(channel.error);
    }

    if (!isManager(channel.value, callerBotId)) {
        return failed(`Only the manager of ${channel.value.name} can add members.`);
    }

    if ('error' in bot) {
        return failed(bot.error);
    }

    try {
        await deps.channels.addMember(channel.value.id, bot.value.id);

        return done(`${bot.value.name} joined ${channel.value.name}.`);
    } catch (error) {
        if (error instanceof ChannelError) {
            return failed(error.message);
        }

        throw error;
    }
}

// Makes another member the manager. Only the current manager can do it.
async function setManager(deps: ChannelCommandDeps, input: { channel: string; bot: string }, callerBotId: string): Promise<ChannelCommandResult> {
    const channel = await resolveChannel(deps.channels, input.channel);
    const bot = await resolveBot(deps.bots, input.bot);

    if ('error' in channel) {
        return failed(channel.error);
    }

    if (!isManager(channel.value, callerBotId)) {
        return failed(`Only the manager of ${channel.value.name} can change the manager.`);
    }

    if ('error' in bot) {
        return failed(bot.error);
    }

    try {
        await deps.channels.setManager(channel.value.id, bot.value.id);

        return done(`${bot.value.name} is now the manager of ${channel.value.name}.`);
    } catch (error) {
        if (error instanceof ChannelError) {
            return failed(error.message);
        }

        throw error;
    }
}

// Removes a member. The owner approves each removal in the chat, since it changes who takes part.
async function removeMember(deps: ChannelCommandDeps, input: { channel: string; bot: string }): Promise<ChannelCommandResult> {
    const channel = await resolveChannel(deps.channels, input.channel);
    const bot = await resolveBot(deps.bots, input.bot);

    if ('error' in channel) {
        return failed(channel.error);
    }

    if ('error' in bot) {
        return failed(bot.error);
    }

    try {
        await deps.channels.removeMember(channel.value.id, bot.value.id);
    } catch (error) {
        if (error instanceof ChannelError) {
            return failed(error.message);
        }

        throw error;
    }

    await deps.memberLeft?.(channel.value.id, bot.value.id);

    return done(`${bot.value.name} left ${channel.value.name}.`);
}

// Deletes a channel and its messages. The owner approves it in the chat.
async function deleteChannel(deps: ChannelCommandDeps, input: { channel: string }): Promise<ChannelCommandResult> {
    const channel = await resolveChannel(deps.channels, input.channel);

    if ('error' in channel) {
        return failed(channel.error);
    }

    await deps.channelDeleting?.(channel.value.id);
    await deps.channels.deleteChannel(channel.value.id);

    return done(`Deleted the channel ${channel.value.name}.`);
}

export { MAX_MEMBERS_PER_CALL, addMember, createChannel, createOwnerChannel, deleteChannel, findNameClash, listChannels, reachableBots, removeMember, setManager, updateOwnerChannel };
export type { ChannelCommandDeps, ChannelCommandResult };
