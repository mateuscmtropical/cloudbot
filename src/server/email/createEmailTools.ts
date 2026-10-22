import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool, CloudbotToolResult } from '../agent/cloudbotTool.ts';
import type { EmailAccountService } from './EmailAccountService.ts';
import { EMAIL_SEND_TOOL_NAME, EMAIL_SETUP_TOOL_NAME, EMAIL_STATUS_TOOL_NAME } from './emailToolNames.ts';
import { parseEmailAccountSettings, parseOutgoingEmail } from './emailValidation.ts';
import type { SmtpEmailSender } from './SmtpEmailSender.ts';

interface EmailToolsOptions {
    accountService: Pick<EmailAccountService, 'getAccount' | 'hasPassword' | 'saveSettings'>;
    sender: Pick<SmtpEmailSender, 'send'>;
    postPasswordForm: (botId: string) => Promise<unknown>;
}

const EMAIL_SETUP_TOOL_SHAPE = {
    address: z.string(),
    imapHost: z.string(),
    imapPort: z.number(),
    smtpHost: z.string(),
    smtpPort: z.number(),
    smtpSecure: z.boolean()
        .optional(),
    username: z.string()
        .optional(),
};

const EMAIL_RECIPIENT_SCHEMA = z.string();
const EMAIL_RECIPIENTS_SCHEMA = z.array(EMAIL_RECIPIENT_SCHEMA);
const OPTIONAL_EMAIL_RECIPIENTS_SCHEMA = EMAIL_RECIPIENTS_SCHEMA.optional();

const EMAIL_SEND_TOOL_SHAPE = {
    to: EMAIL_RECIPIENTS_SCHEMA,
    cc: OPTIONAL_EMAIL_RECIPIENTS_SCHEMA,
    bcc: OPTIONAL_EMAIL_RECIPIENTS_SCHEMA,
    subject: z.string(),
    text: z.string(),
};

const EMAIL_STATUS_TOOL_SHAPE = {};

function textResult(text: string, isError = false): CloudbotToolResult {
    const textContent = { type: 'text' as const, text };

    return isError ? { content: [textContent], isError: true } : { content: [textContent] };
}

function createEmailTools(botId: string, options: EmailToolsOptions): CloudbotTool[] {
    const setupTool = tool(
        EMAIL_SETUP_TOOL_NAME,
        'Connect the bot mailbox with the IMAP and SMTP settings the owner gave you. Never ask for or include the password here. After approval, a secure password form appears in the chat.',
        EMAIL_SETUP_TOOL_SHAPE,
        async (args): Promise<CloudbotToolResult> => {
            const parsed = parseEmailAccountSettings(args);

            if (!parsed.ok) {
                return textResult(parsed.reason, true);
            }

            try {
                const saved = await options.accountService.saveSettings(botId, parsed.settings);

                await options.postPasswordForm(botId);

                const changeText = saved.isChanged ? 'New mailbox settings saved.' : 'Mailbox settings confirmed.';

                return textResult(`${changeText} The owner can enter the password in the secure form in chat.`);
            } catch {
                return textResult('The mailbox settings could not be saved. Check the settings and try again.', true);
            }
        },
    );
    const sendTool = tool(
        EMAIL_SEND_TOOL_NAME,
        'Send plain text email from the bot mailbox. Every send waits for the owner to approve a card that shows all recipients, the subject and the whole text. Never change the email after that approval.',
        EMAIL_SEND_TOOL_SHAPE,
        async (args): Promise<CloudbotToolResult> => {
            const parsed = parseOutgoingEmail(args);

            if (!parsed.ok) {
                return textResult(parsed.reason, true);
            }

            const result = await options.sender.send(botId, parsed.message);

            return result.ok ? textResult('The email was sent.') : textResult(result.reason ?? 'The email could not be sent.', true);
        },
    );
    const statusTool = tool(
        EMAIL_STATUS_TOOL_NAME,
        'Check whether the bot mailbox is set up. This does not read or reveal the password.',
        EMAIL_STATUS_TOOL_SHAPE,
        async (): Promise<CloudbotToolResult> => {
            const account = await options.accountService.getAccount(botId);

            if (account === undefined) {
                return textResult('The bot mailbox is not connected. Ask the owner for the IMAP and SMTP settings, then use email_setup.');
            }

            const hasPassword = options.accountService.hasPassword(botId);
            const passwordText = hasPassword ? 'password saved in the vault' : 'password still needed in the secure form';

            return textResult(`Mailbox ${account.address} is configured. IMAP ${account.imapHost}:${String(account.imapPort)}. SMTP ${account.smtpHost}:${String(account.smtpPort)}. The ${passwordText}.`);
        },
    );

    return [setupTool, statusTool, sendTool];
}

export { EMAIL_SEND_TOOL_SHAPE, EMAIL_SETUP_TOOL_SHAPE, EMAIL_STATUS_TOOL_SHAPE, createEmailTools };
export type { EmailToolsOptions };
