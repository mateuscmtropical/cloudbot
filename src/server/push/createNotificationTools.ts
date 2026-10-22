import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';

interface NotificationToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// Posts the card with the button. It throws when the card cannot be posted.
type NotificationCardHandler = () => Promise<void>;

const NOTIFICATIONS_ENABLE_TOOL_NAME = 'notifications_enable';
const NOTIFICATIONS_ENABLE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${NOTIFICATIONS_ENABLE_TOOL_NAME}`;
const NOTIFICATIONS_DISABLE_TOOL_NAME = 'notifications_disable';
const NOTIFICATIONS_DISABLE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${NOTIFICATIONS_DISABLE_TOOL_NAME}`;
const NOTIFICATIONS_DISABLE_DESCRIPTION = 'Use this when the owner asks to stop the notifications on their phone or computer. It posts a card in the chat with a button. The browser forgets its subscription only after the owner taps the button, so you cannot turn notifications off yourself.';
const NOTIFICATIONS_ENABLE_DESCRIPTION = 'Use this when the owner asks to get notifications on their phone or computer. It posts a card in the chat with a button. The browser asks for permission only after the owner taps the button, so you cannot turn notifications on yourself. The card already says what is sent.';

function textResult(text: string, isError = false): NotificationToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function createCardTool(name: string, description: string, doneText: string, postCard: NotificationCardHandler): CloudbotTool {
    return tool(
        name,
        description,
        {},
        async (): Promise<NotificationToolResult> => {
            try {
                await postCard();

                return textResult(doneText);
            } catch {
                return textResult('The card could not be posted.', true);
            }
        },
    );
}

function createNotificationsEnableTool(postCard: NotificationCardHandler): CloudbotTool {
    return createCardTool(NOTIFICATIONS_ENABLE_TOOL_NAME, NOTIFICATIONS_ENABLE_DESCRIPTION, 'A card with a button to turn on notifications is in the chat. Tell the owner in one short sentence to tap it, then stop. Do not repeat what the card says.', postCard);
}

function createNotificationsDisableTool(postCard: NotificationCardHandler): CloudbotTool {
    return createCardTool(NOTIFICATIONS_DISABLE_TOOL_NAME, NOTIFICATIONS_DISABLE_DESCRIPTION, 'A card with a button to turn off notifications is in the chat. Tell the owner in one short sentence to tap it, then stop. Do not repeat what the card says.', postCard);
}

export { NOTIFICATIONS_DISABLE_TOOL_FULL_NAME, NOTIFICATIONS_ENABLE_TOOL_FULL_NAME, createNotificationsDisableTool, createNotificationsEnableTool };
export type { NotificationCardHandler, NotificationToolResult };
