import { createTransport } from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';

import type { EmailAccountRecord } from '../store/EmailAccountStore.ts';
import type { EmailAccountService } from './EmailAccountService.ts';
import type { OutgoingEmail } from './emailValidation.ts';

const SMTP_TIMEOUT_MS = 30 * 1000;

interface SmtpTransportOptions {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    auth: { user: string; pass: string };
    tls: { rejectUnauthorized: true };
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
}

interface MailTransport {
    sendMail(mail: SendMailOptions): Promise<unknown>;
    close(): void;
}

type CreateMailTransport = (account: EmailAccountRecord, password: string) => MailTransport;

interface EmailSendResult {
    ok: boolean;
    reason?: string;
}

interface SmtpEmailSenderOptions {
    createTransport?: CreateMailTransport | undefined;
}

function createSmtpTransportOptions(account: EmailAccountRecord, password: string): SmtpTransportOptions {
    return {
        host: account.smtpHost,
        port: account.smtpPort,
        secure: account.smtpSecure,
        // The other ports must upgrade with STARTTLS. A server that does not offer it never gets the password or the mail.
        requireTLS: !account.smtpSecure,
        auth: { user: account.username, pass: password },
        tls: { rejectUnauthorized: true },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS,
    };
}

function createSmtpTransport(account: EmailAccountRecord, password: string): MailTransport {
    const options = createSmtpTransportOptions(account, password);

    return createTransport(options);
}

async function sendOutgoingEmail(
    account: EmailAccountRecord,
    password: string,
    message: OutgoingEmail,
    createTransportFunction: CreateMailTransport = createSmtpTransport,
): Promise<void> {
    const transport = createTransportFunction(account, password);
    const mail: SendMailOptions = {
        from: account.address,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
    };

    try {
        await transport.sendMail(mail);
    } finally {
        transport.close();
    }
}

// The sender reads the password only when the owner approved the mail, and never puts it in a result or a log.
class SmtpEmailSender {
    private readonly accountService: Pick<EmailAccountService, 'getAccount' | 'readPassword'>;
    private readonly createTransport: CreateMailTransport;

    constructor(accountService: Pick<EmailAccountService, 'getAccount' | 'readPassword'>, options: SmtpEmailSenderOptions = {}) {
        this.accountService = accountService;
        this.createTransport = options.createTransport ?? createSmtpTransport;
    }

    async send(botId: string, message: OutgoingEmail): Promise<EmailSendResult> {
        try {
            const account = await this.accountService.getAccount(botId);

            if (account === undefined) {
                return { ok: false, reason: 'No email account is connected. Use email_setup first.' };
            }

            const password = this.accountService.readPassword(botId);

            if (password === undefined) {
                return { ok: false, reason: 'The mailbox password is not set. Use email_setup to post the password form.' };
            }

            await sendOutgoingEmail(account, password, message, this.createTransport);

            return { ok: true };
        } catch {
            // The error can hold the server greeting or the account, so only the bot id is logged.
            console.error(`Could not send the email of bot ${botId}.`);

            return { ok: false, reason: 'The email could not be sent. Check the mailbox settings and password.' };
        }
    }
}

export {
    SMTP_TIMEOUT_MS,
    SmtpEmailSender,
    createSmtpTransport,
    createSmtpTransportOptions,
    sendOutgoingEmail,
};
export type { CreateMailTransport, EmailSendResult, MailTransport, SmtpEmailSenderOptions, SmtpTransportOptions };
