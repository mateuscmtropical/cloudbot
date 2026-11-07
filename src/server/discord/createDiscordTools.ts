import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { createMessengerTools, messengerToolNames } from '../messenger/createMessengerTools.ts';
import type { MessengerConnector } from '../messenger/createMessengerTools.ts';
import { DISCORD_API_ORIGIN } from './DiscordApi.ts';

// The owner saves the Discord bot token under this name with request_secret, for the Discord site.
const DISCORD_TOKEN_SECRET_NAME = 'DISCORD_BOT_TOKEN';
const DISCORD_TOOL_FULL_NAMES = messengerToolNames('discord').fullNames;

function createDiscordTools(connector: MessengerConnector, botId: string): CloudbotTool[] {
    return createMessengerTools({
        label: 'Discord',
        prefix: 'discord',
        tokenSecretName: DISCORD_TOKEN_SECRET_NAME,
        site: DISCORD_API_ORIGIN,
        codeTarget: 'their Discord bot in a direct message, after the word pair',
        tokenHint: 'in the Discord developer portal and added to a server they own',
    }, connector, botId);
}

export { DISCORD_TOKEN_SECRET_NAME, DISCORD_TOOL_FULL_NAMES, createDiscordTools };
