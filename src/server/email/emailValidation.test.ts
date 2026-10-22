import { describe, expect, it } from 'vitest';

import { isValidEmailAddress, isValidEmailHost, parseEmailAccountSettings, parseOutgoingEmail } from './emailValidation.ts';

describe('parseEmailAccountSettings', () => {
    it('uses the address as the default username and detects implicit TLS by port', () => {
        const result = parseEmailAccountSettings({
            address: ' bot@example.com ',
            imapHost: 'imap.example.com',
            imapPort: 993,
            smtpHost: 'smtp.example.com',
            smtpPort: 465,
        });

        expect(result)
            .toEqual({
                ok: true,
                settings: {
                    address: 'bot@example.com',
                    imapHost: 'imap.example.com',
                    imapPort: 993,
                    smtpHost: 'smtp.example.com',
                    smtpPort: 465,
                    smtpSecure: true,
                    username: 'bot@example.com',
                },
            });
    });

    it('refuses a host with a URL scheme or an invalid port', () => {
        expect(parseEmailAccountSettings({
            address: 'bot@example.com',
            imapHost: 'imaps://imap.example.com',
            imapPort: 993,
            smtpHost: 'smtp.example.com',
            smtpPort: 70000,
        }).ok)
            .toBe(false);
    });
});

describe('parseOutgoingEmail', () => {
    it('keeps every recipient field and defaults missing cc and bcc to empty lists', () => {
        const result = parseOutgoingEmail({
            to: [' ana@example.com '],
            subject: ' Hello ',
            text: 'The body stays as written.\n',
        });

        expect(result)
            .toEqual({ ok: true, message: { to: ['ana@example.com'], cc: [], bcc: [], subject: 'Hello', text: 'The body stays as written.\n' } });
    });

    it('refuses an invalid address in cc or bcc and hidden text in the subject', () => {
        expect(parseOutgoingEmail({ to: ['ana@example.com'], cc: ['bad-address'], bcc: [], subject: 'Hi', text: 'Body' }).ok)
            .toBe(false);
        expect(parseOutgoingEmail({ to: ['ana@example.com'], cc: [], bcc: [], subject: 'Hi\u200b', text: 'Body' }).ok)
            .toBe(false);
    });
});

describe('email address validation', () => {
    it('accepts one address and plain host names', () => {
        expect(isValidEmailAddress('bot+inbox@example.com'))
            .toBe(true);
        expect(isValidEmailHost('imap.example.com'))
            .toBe(true);
    });

    it('rejects newline injection in addresses and hosts', () => {
        expect(isValidEmailAddress('bot@example.com\nBcc:other@example.com'))
            .toBe(false);
        expect(isValidEmailHost('smtp.example.com\n.example.net'))
            .toBe(false);
    });
});
