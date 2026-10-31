import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import { MAX_NOTICE_LINE_CHARACTERS, toNoticeLine } from './noticeLine.ts';

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

const NOTIFICATION_TEXT_TOOL_NAME = 'notification_text';
const NOTIFICATION_TEXT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${NOTIFICATION_TEXT_TOOL_NAME}`;
const NOTIFICATION_TEXT_DESCRIPTION = `Sets the line of the notification that tells the owner this turn ended. Without it the notification shows the first line of your last reply. Use it when the owner asked for a certain notification text, for example for a routine, or when the first line of the reply would not say what you did. One line, at most ${String(MAX_NOTICE_LINE_CHARACTERS)} characters. The last call in the turn wins.`;
const NOTIFICATION_TEXT_SHAPE = {
    text: z.string()
        .min(1)
        .max(MAX_NOTICE_LINE_CHARACTERS),
};

// Keeps the line for the notification at the end of the turn.
type NotificationTextHandler = (text: string) => void;

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

function createNotificationTextTool(setText: NotificationTextHandler): CloudbotTool {
    return tool(
        NOTIFICATION_TEXT_TOOL_NAME,
        NOTIFICATION_TEXT_DESCRIPTION,
        NOTIFICATION_TEXT_SHAPE,
        (input: { text: string }): Promise<NotificationToolResult> => {
            const line = toNoticeLine(input.text);
            const result = line === undefined
                ? textResult('The notification text is empty.', true)
                : textResult('The notification at the end of this turn will show this line.');

            if (line !== undefined) {
                setText(line);
            }

            return Promise.resolve(result);
        },
    );
}

export {
    NOTIFICATION_TEXT_TOOL_FULL_NAME,
    NOTIFICATIONS_DISABLE_TOOL_FULL_NAME,
    NOTIFICATIONS_ENABLE_TOOL_FULL_NAME,
    createNotificationTextTool,
    createNotificationsDisableTool,
    createNotificationsEnableTool,
};
export type { NotificationCardHandler, NotificationTextHandler, NotificationToolResult };
