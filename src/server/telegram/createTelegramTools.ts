import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { createMessengerTools, messengerToolNames } from '../messenger/createMessengerTools.ts';
import type { MessengerConnector, MessengerToolResult } from '../messenger/createMessengerTools.ts';
import { TELEGRAM_API_ORIGIN } from './TelegramApi.ts';

type TelegramToolResult = MessengerToolResult;
type TelegramConnector = MessengerConnector;

// The owner saves the Telegram bot token under this name with request_secret, for the Telegram API site.
const TELEGRAM_TOKEN_SECRET_NAME = 'TELEGRAM_BOT_TOKEN';
const TELEGRAM_TOOL_NAMES = messengerToolNames('telegram');
const TELEGRAM_CONNECT_TOOL_NAME = TELEGRAM_TOOL_NAMES.connect;
const TELEGRAM_DISCONNECT_TOOL_NAME = TELEGRAM_TOOL_NAMES.disconnect;
const TELEGRAM_TOOL_FULL_NAMES = TELEGRAM_TOOL_NAMES.fullNames;

function createTelegramTools(connector: TelegramConnector, botId: string): CloudbotTool[] {
    return createMessengerTools({
        label: 'Telegram',
        prefix: 'telegram',
        tokenSecretName: TELEGRAM_TOKEN_SECRET_NAME,
        site: TELEGRAM_API_ORIGIN,
        codeTarget: 'their Telegram bot',
        tokenHint: 'with @BotFather',
    }, connector, botId);
}

export { TELEGRAM_CONNECT_TOOL_NAME, TELEGRAM_DISCONNECT_TOOL_NAME, TELEGRAM_TOKEN_SECRET_NAME, TELEGRAM_TOOL_FULL_NAMES, createTelegramTools };
export type { TelegramConnector, TelegramToolResult };
