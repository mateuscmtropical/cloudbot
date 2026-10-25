import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool } from '../agent/cloudbotTool.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { WhatsAppConnectOutcome } from './WhatsAppSetup.ts';

interface WhatsAppToolResult {
    [key: string]: unknown;
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

// The part of WhatsAppSetup the tools use.
interface WhatsAppConnector {
    connect: (botId: string, phoneNumberId: string) => Promise<WhatsAppConnectOutcome>;
    disconnect: (botId: string) => Promise<boolean>;
}

const WHATSAPP_CONNECT_TOOL_NAME = 'whatsapp_connect';
const WHATSAPP_DISCONNECT_TOOL_NAME = 'whatsapp_disconnect';
const WHATSAPP_CONNECT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WHATSAPP_CONNECT_TOOL_NAME}`;
const WHATSAPP_DISCONNECT_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${WHATSAPP_DISCONNECT_TOOL_NAME}`;
const WHATSAPP_TOOL_FULL_NAMES = [WHATSAPP_CONNECT_TOOL_FULL_NAME, WHATSAPP_DISCONNECT_TOOL_FULL_NAME];

const CONNECT_DESCRIPTION = 'Connect this bot to the owner\'s WhatsApp number through the official Meta WhatsApp Business Cloud API. It brings the owner\'s messages into this chat. Ask the owner for the numeric Phone number ID under the Meta app\'s WhatsApp, API Setup. The tool posts a secure form for each thing it still needs: the Meta App Secret, a verify token, and the owner\'s WhatsApp number. After each form, call whatsapp_connect again. When it succeeds, give the owner the callback URL and say to paste it in Meta under WhatsApp, Configuration, Webhook, with the same verify token, and to subscribe to the messages field. Never ask for the app secret, the verify token or the owner\'s number in the chat.';
const DISCONNECT_DESCRIPTION = 'Use this when the owner wants to stop sending instructions from WhatsApp. It forgets the WhatsApp number and removes the app secret, the verify token and the owner\'s number from the vault. The owner must also remove the webhook in Meta.';

const CONNECT_SHAPE = {
    phoneNumberId: z.string()
        .trim()
        .min(1)
        .max(64),
};
const DISCONNECT_SHAPE = {};

const SECRET_LABELS: Record<string, string> = {
    WHATSAPP_APP_SECRET: 'Meta app secret',
    WHATSAPP_VERIFY_TOKEN: 'verify token',
    WHATSAPP_OWNER_NUMBER: 'WhatsApp number',
};

function textResult(text: string, isError = false): WhatsAppToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

function describeForm(outcome: Extract<WhatsAppConnectOutcome, { status: 'form' }>): WhatsAppToolResult {
    const label = SECRET_LABELS[outcome.secretName] ?? outcome.secretName;
    const opening = outcome.isReplacement
        ? `The saved ${label} is not valid. A new secure form is in the chat.`
        : `A secure form for the ${label} is in the chat.`;

    return textResult(`${opening} Ask the owner to fill it in, then call whatsapp_connect again.`);
}

function describeConnect(outcome: WhatsAppConnectOutcome): WhatsAppToolResult {
    if (outcome.status === 'form') {
        return describeForm(outcome);
    }

    if (outcome.status === 'invalid-phone-number-id') {
        return textResult('The phone number ID must be the numeric ID from Meta, not the phone number. Ask the owner to copy it from the Meta app\'s WhatsApp, API Setup.', true);
    }

    if (outcome.status === 'phone-taken') {
        return textResult('That WhatsApp number is already connected to another bot. Disconnect it there first.', true);
    }

    if (outcome.status === 'bot-linked') {
        return textResult(`This bot is already connected to phone number ID ${outcome.phoneNumberId}. Disconnect it first to use another number.`, true);
    }

    const alreadyText = outcome.isAlreadyLinked ? ' already' : '';

    return textResult(`WhatsApp is${alreadyText} connected for phone number ID ${outcome.phoneNumberId}. Give the owner this callback URL in one short message: ${outcome.callbackUrl}. Say to paste it in Meta under WhatsApp, Configuration, Webhook, with the same verify token, and to subscribe to the messages field. Only messages from the owner's number are accepted, and you never send a WhatsApp message.`);
}

function createWhatsAppTools(connector: WhatsAppConnector, botId: string): CloudbotTool[] {
    const connectTool = tool(
        WHATSAPP_CONNECT_TOOL_NAME,
        CONNECT_DESCRIPTION,
        CONNECT_SHAPE,
        async (args): Promise<WhatsAppToolResult> => {
            try {
                const outcome = await connector.connect(botId, args.phoneNumberId);

                return describeConnect(outcome);
            } catch {
                return textResult('WhatsApp could not be set up. Try again later.', true);
            }
        },
    );
    const disconnectTool = tool(
        WHATSAPP_DISCONNECT_TOOL_NAME,
        DISCONNECT_DESCRIPTION,
        DISCONNECT_SHAPE,
        async (): Promise<WhatsAppToolResult> => {
            try {
                const wasConnected = await connector.disconnect(botId);

                return textResult(wasConnected ? 'WhatsApp is disconnected.' : 'WhatsApp was not connected.');
            } catch {
                return textResult('WhatsApp could not be disconnected. Try again later.', true);
            }
        },
    );

    return [connectTool, disconnectTool];
}

export {
    CONNECT_DESCRIPTION,
    DISCONNECT_DESCRIPTION,
    SECRET_LABELS,
    WHATSAPP_CONNECT_TOOL_FULL_NAME,
    WHATSAPP_CONNECT_TOOL_NAME,
    WHATSAPP_DISCONNECT_TOOL_FULL_NAME,
    WHATSAPP_DISCONNECT_TOOL_NAME,
    WHATSAPP_TOOL_FULL_NAMES,
    createWhatsAppTools,
};
export type { WhatsAppConnector, WhatsAppToolResult };
