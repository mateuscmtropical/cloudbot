import { isHiddenCode } from '../text/isHiddenCode.ts';
import { OUTSIDE_DATA_LINE } from '../webhooks/webhookMessage.ts';

// The first line of every incoming mail. The review context reads it to label the mail as outside data.
const EMAIL_MESSAGE_PREFIX = 'Email to ';
const MAX_EMAIL_TEXT_LENGTH = 20000;
const MAX_HEADER_LENGTH = 300;
const NO_TEXT_LINE = 'The email has no text body.';

type EmailSkipReason = 'too-large' | 'unreadable';

interface IncomingEmailMessage {
    address: string;
    sender: string;
    subject: string;
    receivedAt: string | undefined;
    text: string;
    attachmentCount: number;
}

function stripHiddenCode(text: string): string {
    return Array.from(text)
        .filter((character) => {
            const code = character.codePointAt(0) ?? 0;

            return !isHiddenCode(code);
        })
        .join('');
}

function toOneLine(text: string): string {
    const stripped = stripHiddenCode(text);
    const collapsed = stripped.replace(/\s+/g, ' ')
        .trim();

    return collapsed.length > MAX_HEADER_LENGTH ? `${collapsed.slice(0, MAX_HEADER_LENGTH - 3)}...` : collapsed;
}

function capText(text: string): string {
    const stripped = stripHiddenCode(text);

    if (stripped.length <= MAX_EMAIL_TEXT_LENGTH) {
        return stripped;
    }

    const shown = stripped.slice(0, MAX_EMAIL_TEXT_LENGTH);

    return `${shown}\n\n[The email was longer. The rest was not shown.]`;
}

function attachmentLine(count: number): string {
    if (count === 0) {
        return 'Attachments: none';
    }

    return `Attachments: ${String(count)} (their contents were not read)`;
}

// The mail comes from outside, so the chat message marks the sender, the subject and the text as data.
// The first two lines are fixed, so the review context can label the message the same way as a webhook call.
function buildEmailMessage(email: IncomingEmailMessage): string {
    const plainAddress = toOneLine(email.address);
    const plainSender = toOneLine(email.sender);
    const plainSubject = toOneLine(email.subject);
    const address = plainAddress === '' ? '(unknown address)' : plainAddress;
    const sender = plainSender === '' ? '(unknown sender)' : plainSender;
    const subject = plainSubject === '' ? '(no subject)' : plainSubject;
    const text = capText(email.text);
    const bodyText = text.trim() === '' ? NO_TEXT_LINE : text;
    const dateLine = email.receivedAt === undefined ? [] : [`Date: ${email.receivedAt}`];
    const metadata = [`Subject: ${subject}`, ...dateLine, attachmentLine(email.attachmentCount)];

    return [
        `${EMAIL_MESSAGE_PREFIX}${address} from ${sender}`,
        OUTSIDE_DATA_LINE,
        '',
        ...metadata,
        '',
        bodyText,
    ].join('\n');
}

// Both lines must match, so an owner message that only starts with the prefix is not taken for a mail.
function isEmailMessage(text: string): boolean {
    const [firstLine, secondLine] = text.split('\n');

    return firstLine?.startsWith(EMAIL_MESSAGE_PREFIX) === true && secondLine === OUTSIDE_DATA_LINE;
}

// The notice says nothing from the mail, since a skipped mail is still untrusted.
function buildEmailSkipNotice(reason: EmailSkipReason): string {
    return reason === 'too-large'
        ? 'An email was not read because it is larger than 1 MB.'
        : 'An email was not read because it could not be read.';
}

export {
    EMAIL_MESSAGE_PREFIX,
    MAX_EMAIL_TEXT_LENGTH,
    buildEmailMessage,
    buildEmailSkipNotice,
    isEmailMessage,
};
export type { EmailSkipReason, IncomingEmailMessage };
