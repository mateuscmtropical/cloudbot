import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { TELEGRAM_API_ORIGIN } from './TelegramApi.ts';

interface TelegramToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The part of TelegramBridge the tools use.
interface TelegramConnector {
    startPairing: (botId: string) => Promise<boolean>;
    disconnect: (botId: string) => Promise<boolean>;
}

// The owner saves the Telegram bot token under this name with request_secret, for the Telegram API site.
const TELEGRAM_TOKEN_SECRET_NAME = 'TELEGRAM_BOT_TOKEN';
const TELEGRAM_CONNECT_TOOL_NAME = 'telegram_connect';
const TELEGRAM_DISCONNECT_TOOL_NAME = 'telegram_disconnect';
const TELEGRAM_TOOL_FULL_NAMES = [TELEGRAM_CONNECT_TOOL_NAME, TELEGRAM_DISCONNECT_TOOL_NAME].map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`);
const TELEGRAM_CONNECT_DESCRIPTION = `Use this when the owner wants to talk to you from Telegram. It needs a Telegram bot token that the owner made with @BotFather. If it says there is no token, ask for it with request_secret, name ${TELEGRAM_TOKEN_SECRET_NAME}, site ${TELEGRAM_API_ORIGIN}, then call this again. On success a one-time code is posted in the chat for the owner. You never see the code.`;
const TELEGRAM_DISCONNECT_DESCRIPTION = 'Use this when the owner wants to stop talking to you from Telegram. It forgets the Telegram account. The token stays saved until the owner asks to remove it.';

function textResult(text: string, isError = false): TelegramToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createTelegramTools(connector: TelegramConnector, botId: string): CloudbotTool[] {
    const connectTool = tool(
        TELEGRAM_CONNECT_TOOL_NAME,
        TELEGRAM_CONNECT_DESCRIPTION,
        {},
        async (): Promise<TelegramToolResult> => {
            try {
                const isStarted = await connector.startPairing(botId);

                if (!isStarted) {
                    return textResult(`There is no Telegram bot token for you yet. Ask the owner for it with request_secret, name ${TELEGRAM_TOKEN_SECRET_NAME}, site ${TELEGRAM_API_ORIGIN}.`, true);
                }

                return textResult('A one-time code is in the chat. Tell the owner in one short sentence to send it to their Telegram bot as the message above says, then stop.');
            } catch {
                return textResult('Telegram could not be set up. Try again later.', true);
            }
        },
    );
    const disconnectTool = tool(
        TELEGRAM_DISCONNECT_TOOL_NAME,
        TELEGRAM_DISCONNECT_DESCRIPTION,
        {},
        async (): Promise<TelegramToolResult> => {
            try {
                const wasConnected = await connector.disconnect(botId);

                return textResult(wasConnected ? 'Telegram is disconnected.' : 'Telegram was not connected.');
            } catch {
                return textResult('Telegram could not be disconnected. Try again later.', true);
            }
        },
    );

    return [connectTool, disconnectTool];
}

export { TELEGRAM_CONNECT_TOOL_NAME, TELEGRAM_DISCONNECT_TOOL_NAME, TELEGRAM_TOKEN_SECRET_NAME, TELEGRAM_TOOL_FULL_NAMES, createTelegramTools };
export type { TelegramConnector, TelegramToolResult };
