import { describe, expect, it } from 'vitest';

import { describeEmailSend, describeEmailSetup } from './emailApproval.ts';

describe('describeEmailSend', () => {
    it('shows every recipient, subject and the full text on the approval card', () => {
        const verdict = describeEmailSend({
            to: ['to@example.com'],
            cc: ['cc@example.com'],
            bcc: ['bcc@example.com'],
            subject: 'A subject',
            text: 'The full body\nwith another line.',
        });

        expect(verdict)
            .toEqual({
                decision: 'ask',
                summary: 'Send an email.',
                detail: 'To: to@example.com\nCc: cc@example.com\nBcc: bcc@example.com\nSubject: "A subject"\n\nText:\nThe full body\nwith another line.',
            });
    });

    it('refuses a card that cannot show the complete body', () => {
        const longAddress = `${'a'.repeat(240)}@example.com`;
        const manyRecipients = Array.from({ length: 20 }, () => longAddress);
        const body = 'x'.repeat(10000);
        const verdict = describeEmailSend({ to: manyRecipients, cc: manyRecipients, bcc: manyRecipients, subject: 'Long', text: body });

        expect(verdict)
            .toEqual({ decision: 'deny', reason: 'The email is too long to show the owner whole, so it was not approved.' });
    });

    it('refuses invalid recipient input without building a card', () => {
        const verdict = describeEmailSend({ to: ['bad-address'], subject: 'Hi', text: 'Body' });

        expect(verdict.decision)
            .toBe('deny');
    });
});

describe('describeEmailSetup', () => {
    it('shows settings and the password workflow without including a password', () => {
        const verdict = describeEmailSetup({
            address: 'bot@example.com',
            username: 'bot-user',
            imapHost: 'imap.example.com',
            imapPort: 993,
            smtpHost: 'smtp.example.com',
            smtpPort: 587,
            smtpSecure: false,
        });

        expect(verdict.decision)
            .toBe('ask');
        if (verdict.decision === 'ask') {
            expect(verdict.detail)
                .toContain('SMTP: smtp.example.com:587, STARTTLS required');
            expect(verdict.detail)
                .not.toContain('password-value');
        }
    });
});
