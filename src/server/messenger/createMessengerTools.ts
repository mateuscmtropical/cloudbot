import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

interface MessengerToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The part of a messenger bridge the tools use.
interface MessengerConnector {
    startPairing: (botId: string) => Promise<boolean>;
    disconnect: (botId: string) => Promise<boolean>;
    isConnected?: (botId: string) => boolean;
}

interface MessengerToolsConfig {
    // The messenger name as the owner reads it, such as Telegram.
    label: string;
    // The tools are named <prefix>_connect and <prefix>_disconnect.
    prefix: string;
    // The owner saves the messenger bot token under this name with request_secret.
    tokenSecretName: string;
    // The site the token is saved for.
    site: string;
    // Where the owner sends the code, as a short phrase such as "their Telegram bot".
    codeTarget: string;
    // Extra words for the connect description, such as how the owner makes the bot.
    tokenHint: string;
}

function textResult(text: string, isError = false): MessengerToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function messengerToolNames(prefix: string): { connect: string; disconnect: string; fullNames: string[] } {
    const connect = `${prefix}_connect`;
    const disconnect = `${prefix}_disconnect`;

    return { connect, disconnect, fullNames: [connect, disconnect].map(name => `mcp__${PROFILE_SERVER_NAME}__${name}`) };
}

function createMessengerTools(config: MessengerToolsConfig, connector: MessengerConnector, botId: string): CloudbotTool[] {
    const { label, tokenSecretName, site } = config;
    const names = messengerToolNames(config.prefix);
    const connectDescription = `Use this when the owner wants to talk to you from ${label}. It needs a ${label} bot token that the owner made ${config.tokenHint}. If it says there is no token, ask for it with request_secret, name ${tokenSecretName}, site ${site}, then call this again. On success a one-time code is posted in the chat for the owner. You never see the code.`;
    const disconnectDescription = `Use this when the owner wants to stop talking to you from ${label}. It forgets the ${label} account. The token stays saved until the owner asks to remove it.`;
    const connectTool = tool(
        names.connect,
        connectDescription,
        {},
        async (): Promise<MessengerToolResult> => {
            try {
                const isStarted = await connector.startPairing(botId);

                if (!isStarted) {
                    return textResult(`There is no ${label} bot token for you yet. Ask the owner for it with request_secret, name ${tokenSecretName}, site ${site}.`, true);
                }

                return textResult(`A one-time code is in the chat. Tell the owner in one short sentence to send it to ${config.codeTarget} as the message above says, then stop.`);
            } catch {
                return textResult(`${label} could not be set up. Try again later.`, true);
            }
        },
    );
    const disconnectTool = tool(
        names.disconnect,
        disconnectDescription,
        {},
        async (): Promise<MessengerToolResult> => {
            try {
                const wasConnected = await connector.disconnect(botId);

                return textResult(wasConnected ? `${label} is disconnected.` : `${label} was not connected.`);
            } catch {
                return textResult(`${label} could not be disconnected. Try again later.`, true);
            }
        },
    );

    return [connectTool, disconnectTool];
}

export { createMessengerTools, messengerToolNames };
export type { MessengerConnector, MessengerToolResult, MessengerToolsConfig };
