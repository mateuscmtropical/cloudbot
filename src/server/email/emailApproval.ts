import type { ToolCallVerdict } from '../approvals/ApprovalGate.ts';
import { parseEmailAccountSettings, parseOutgoingEmail } from './emailValidation.ts';
import type { OutgoingEmail } from './emailValidation.ts';

// The card is shown whole. A longer one is refused, since the gate never cuts the text the owner reads.
const MAX_CARD_CHARS = 12000;

function formatRecipients(addresses: string[]): string {
    return addresses.length === 0 ? '(none)' : addresses.join(', ');
}

function buildSendDetail(message: OutgoingEmail): string {
    return [
        `To: ${formatRecipients(message.to)}`,
        `Cc: ${formatRecipients(message.cc)}`,
        `Bcc: ${formatRecipients(message.bcc)}`,
        `Subject: ${JSON.stringify(message.subject)}`,
        '',
        'Text:',
        message.text,
    ].join('\n');
}

// The owner approves the whole mail, including every recipient that sees a copy. The mail cannot change after approval.
function describeEmailSend(input: unknown): ToolCallVerdict {
    const parsed = parseOutgoingEmail(input);

    if (!parsed.ok) {
        return { decision: 'deny', reason: parsed.reason };
    }

    const detail = buildSendDetail(parsed.message);

    if (detail.length > MAX_CARD_CHARS) {
        return { decision: 'deny', reason: 'The email is too long to show the owner whole, so it was not approved.' };
    }

    return { decision: 'ask', summary: 'Send an email.', detail };
}

// The password is not part of the card and arrives later through the secure form.
function describeEmailSetup(input: unknown): ToolCallVerdict {
    const parsed = parseEmailAccountSettings(input);

    if (!parsed.ok) {
        return { decision: 'deny', reason: parsed.reason };
    }

    const { settings } = parsed;
    const smtpSecurity = settings.smtpSecure ? 'implicit TLS' : 'STARTTLS required';
    const detail = [
        `Address: ${settings.address}`,
        `IMAP: ${settings.imapHost}:${String(settings.imapPort)}, implicit TLS`,
        `SMTP: ${settings.smtpHost}:${String(settings.smtpPort)}, ${smtpSecurity}`,
        `Username: ${settings.username}`,
        '',
        'Mail already in the inbox is not read. If these settings change, the saved password is cleared and new mail is read from the change.',
    ].join('\n');

    return { decision: 'ask', summary: 'Connect the bot\'s email account.', detail };
}

export { MAX_CARD_CHARS, buildSendDetail, describeEmailSend, describeEmailSetup };
