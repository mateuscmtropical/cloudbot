import { z } from 'zod/v4';

import type { EmailAccountSettings } from '../store/EmailAccountStore.ts';
import { hasHiddenCode } from '../text/isHiddenCode.ts';

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_EMAIL_ADDRESS_LENGTH = 254;
const MAX_EMAIL_HOST_LENGTH = 253;
const MAX_EMAIL_USERNAME_LENGTH = 320;
const MAX_EMAIL_SUBJECT_LENGTH = 200;
const MAX_EMAIL_TEXT_LENGTH = 10000;
const MAX_EMAIL_RECIPIENTS = 20;
const IMPLICIT_TLS_PORT = 465;
const EMAIL_ADDRESS_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IPV6_HOST_PATTERN = /^\[[0-9A-Fa-f:.]+\]$/;
const LINE_BREAK_PATTERN = /[\r\n]/;

interface OutgoingEmail {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    text: string;
}

interface ParseFailure {
    ok: false;
    reason: string;
}

interface AccountSettingsSuccess {
    ok: true;
    settings: EmailAccountSettings;
}

interface OutgoingEmailSuccess {
    ok: true;
    message: OutgoingEmail;
}

type AccountSettingsResult = AccountSettingsSuccess | ParseFailure;
type OutgoingEmailResult = OutgoingEmailSuccess | ParseFailure;

function isValidEmailAddress(text: string): boolean {
    if (text.length > MAX_EMAIL_ADDRESS_LENGTH || hasHiddenCode(text) || LINE_BREAK_PATTERN.test(text)) {
        return false;
    }

    if (!EMAIL_ADDRESS_PATTERN.test(text)) {
        return false;
    }

    const parts = text.split('@');
    const localPart = parts[0];

    return localPart !== undefined
        && !localPart.startsWith('.')
        && !localPart.endsWith('.')
        && !localPart.includes('..');
}

function isValidEmailHost(text: string): boolean {
    if (text.length === 0 || text.length > MAX_EMAIL_HOST_LENGTH || hasHiddenCode(text) || LINE_BREAK_PATTERN.test(text)) {
        return false;
    }

    if (IPV6_HOST_PATTERN.test(text)) {
        return true;
    }

    return HOST_PATTERN.test(text) && !text.includes('..');
}

const ACCOUNT_SETTINGS_SCHEMA = z.object({
    address: z.string()
        .trim()
        .min(1)
        .max(MAX_EMAIL_ADDRESS_LENGTH),
    imapHost: z.string()
        .trim()
        .min(1)
        .max(MAX_EMAIL_HOST_LENGTH),
    imapPort: z.number()
        .int()
        .min(MIN_PORT)
        .max(MAX_PORT),
    smtpHost: z.string()
        .trim()
        .min(1)
        .max(MAX_EMAIL_HOST_LENGTH),
    smtpPort: z.number()
        .int()
        .min(MIN_PORT)
        .max(MAX_PORT),
    smtpSecure: z.boolean()
        .optional(),
    username: z.string()
        .trim()
        .min(1)
        .max(MAX_EMAIL_USERNAME_LENGTH)
        .optional(),
})
    .superRefine((value, context) => {
        if (!isValidEmailAddress(value.address)) {
            context.addIssue({ code: 'custom', path: ['address'], message: 'The address is not a valid email address.' });
        }

        if (!isValidEmailHost(value.imapHost)) {
            context.addIssue({ code: 'custom', path: ['imapHost'], message: 'The IMAP host is not a valid host name.' });
        }

        if (!isValidEmailHost(value.smtpHost)) {
            context.addIssue({ code: 'custom', path: ['smtpHost'], message: 'The SMTP host is not a valid host name.' });
        }

        if (value.username !== undefined && (hasHiddenCode(value.username) || LINE_BREAK_PATTERN.test(value.username))) {
            context.addIssue({ code: 'custom', path: ['username'], message: 'The username must be one line without hidden characters.' });
        }
    })
    .transform((value): EmailAccountSettings => ({
        address: value.address,
        imapHost: value.imapHost,
        imapPort: value.imapPort,
        smtpHost: value.smtpHost,
        smtpPort: value.smtpPort,
        smtpSecure: value.smtpSecure ?? value.smtpPort === IMPLICIT_TLS_PORT,
        username: value.username ?? value.address,
    }));

const RECIPIENT_SCHEMA = z.string()
    .trim()
    .min(1)
    .max(MAX_EMAIL_ADDRESS_LENGTH);

const OUTGOING_EMAIL_SCHEMA = z.object({
    to: z.array(RECIPIENT_SCHEMA)
        .min(1)
        .max(MAX_EMAIL_RECIPIENTS),
    cc: z.array(RECIPIENT_SCHEMA)
        .max(MAX_EMAIL_RECIPIENTS)
        .optional(),
    bcc: z.array(RECIPIENT_SCHEMA)
        .max(MAX_EMAIL_RECIPIENTS)
        .optional(),
    subject: z.string()
        .trim()
        .min(1)
        .max(MAX_EMAIL_SUBJECT_LENGTH),
    text: z.string()
        .min(1)
        .max(MAX_EMAIL_TEXT_LENGTH),
})
    .superRefine((value, context) => {
        const recipients = [...value.to, ...(value.cc ?? []), ...(value.bcc ?? [])];

        recipients.forEach((recipient) => {
            if (!isValidEmailAddress(recipient)) {
                context.addIssue({ code: 'custom', path: ['to'], message: 'Every recipient must be one valid email address.' });
            }
        });

        if (hasHiddenCode(value.subject) || LINE_BREAK_PATTERN.test(value.subject)) {
            context.addIssue({ code: 'custom', path: ['subject'], message: 'The subject must be one line without hidden characters.' });
        }

        if (hasHiddenCode(value.text)) {
            context.addIssue({ code: 'custom', path: ['text'], message: 'The text must not have hidden characters.' });
        }
    });

function parseEmailAccountSettings(input: unknown): AccountSettingsResult {
    const parsed = ACCOUNT_SETTINGS_SCHEMA.safeParse(input);

    if (!parsed.success) {
        return { ok: false, reason: 'The email settings are not valid. Use a full email address, a host name without a scheme, and ports from 1 to 65535.' };
    }

    return { ok: true, settings: parsed.data };
}

function parseOutgoingEmail(input: unknown): OutgoingEmailResult {
    const parsed = OUTGOING_EMAIL_SCHEMA.safeParse(input);

    if (!parsed.success) {
        return { ok: false, reason: `The email is not valid. Use at most ${String(MAX_EMAIL_RECIPIENTS)} plain addresses per field, a one line subject, and text of at most ${String(MAX_EMAIL_TEXT_LENGTH)} characters.` };
    }

    const message: OutgoingEmail = {
        to: parsed.data.to,
        cc: parsed.data.cc ?? [],
        bcc: parsed.data.bcc ?? [],
        subject: parsed.data.subject,
        text: parsed.data.text,
    };

    return { ok: true, message };
}

export {
    MAX_EMAIL_RECIPIENTS,
    MAX_EMAIL_SUBJECT_LENGTH,
    MAX_EMAIL_TEXT_LENGTH,
    isValidEmailAddress,
    isValidEmailHost,
    parseEmailAccountSettings,
    parseOutgoingEmail,
};
export type { AccountSettingsResult, OutgoingEmail, OutgoingEmailResult, ParseFailure };
