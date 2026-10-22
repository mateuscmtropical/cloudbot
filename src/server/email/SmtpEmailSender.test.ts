import type { SendMailOptions } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import type { EmailAccountRecord } from '../store/EmailAccountStore.ts';
import type { EmailAccountService } from './EmailAccountService.ts';
import { SmtpEmailSender, createSmtpTransportOptions, sendOutgoingEmail } from './SmtpEmailSender.ts';
import type { MailTransport } from './SmtpEmailSender.ts';
import type { OutgoingEmail } from './emailValidation.ts';

interface TransportFixture {
    sent: SendMailOptions[];
    isClosed: boolean;
}

const ACCOUNT: EmailAccountRecord = {
    botId: 'bot-one',
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
    uidValidity: null,
    lastUid: null,
    createdAt: 1,
    updatedAt: 1,
};

const MESSAGE: OutgoingEmail = {
    to: ['to@example.com'],
    cc: ['cc@example.com'],
    bcc: ['bcc@example.com'],
    subject: 'Hello',
    text: 'The approved text.',
};

function createTransportFixture(): { transport: MailTransport; fixture: TransportFixture } {
    const fixture: TransportFixture = { sent: [], isClosed: false };
    const transport: MailTransport = {
        sendMail: (mail) => {
            fixture.sent.push(mail);

            return Promise.resolve(undefined);
        },
        close: () => {
            fixture.isClosed = true;
        },
    };

    return { transport, fixture };
}

describe('createSmtpTransportOptions', () => {
    it('requires TLS and keeps certificate verification enabled', () => {
        expect(createSmtpTransportOptions(ACCOUNT, 'mail-password'))
            .toMatchObject({ secure: true, requireTLS: false, tls: { rejectUnauthorized: true }, auth: { pass: 'mail-password' } });
        expect(createSmtpTransportOptions({ ...ACCOUNT, smtpSecure: false }, 'mail-password'))
            .toMatchObject({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true } });
    });
});

describe('sendOutgoingEmail', () => {
    it('sends exactly the approved recipients, subject and body, then closes the transport', async () => {
        const { transport, fixture } = createTransportFixture();
        const createTransport = vi.fn(() => transport);

        await sendOutgoingEmail(ACCOUNT, 'mail-password', MESSAGE, createTransport);

        expect(createTransport)
            .toHaveBeenCalledWith(ACCOUNT, 'mail-password');
        expect(fixture.sent)
            .toEqual([{ from: ACCOUNT.address, to: MESSAGE.to, cc: MESSAGE.cc, bcc: MESSAGE.bcc, subject: MESSAGE.subject, text: MESSAGE.text }]);
        expect(fixture.isClosed)
            .toBe(true);
    });

    it('closes the transport when sending fails', async () => {
        const { transport, fixture } = createTransportFixture();
        const failedTransport: MailTransport = {
            sendMail: () => Promise.reject(new Error('provider response with private data')),
            close: () => {
                transport.close();
            },
        };

        await expect(sendOutgoingEmail(ACCOUNT, 'mail-password', MESSAGE, () => failedTransport))
            .rejects.toThrow('provider response');
        expect(fixture.isClosed)
            .toBe(true);
    });
});

describe('SmtpEmailSender', () => {
    it('does not reveal provider errors to the caller', async () => {
        const accountService: Pick<EmailAccountService, 'getAccount' | 'readPassword'> = {
            getAccount: () => Promise.resolve(ACCOUNT),
            readPassword: () => 'mail-password',
        };
        const sender = new SmtpEmailSender(accountService, {
            createTransport: () => ({
                sendMail: () => Promise.reject(new Error('private provider response')),
                close: () => undefined,
            }),
        });

        await expect(sender.send(ACCOUNT.botId, MESSAGE))
            .resolves.toEqual({ ok: false, reason: 'The email could not be sent. Check the mailbox settings and password.' });
    });
});
