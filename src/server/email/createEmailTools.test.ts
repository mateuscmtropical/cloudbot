import { describe, expect, it, vi } from 'vitest';

import type { CloudbotToolResult } from '../agent/cloudbotTool.ts';
import type { EmailAccountRecord, EmailAccountSettings, SaveEmailAccountResult } from '../store/EmailAccountStore.ts';
import type { EmailAccountService } from './EmailAccountService.ts';
import { createEmailTools } from './createEmailTools.ts';
import { EMAIL_SEND_TOOL_FULL_NAME, EMAIL_SETUP_TOOL_FULL_NAME, EMAIL_STATUS_TOOL_FULL_NAME } from './emailToolNames.ts';
import type { SmtpEmailSender } from './SmtpEmailSender.ts';

interface ToolHandlerFixture {
    name: string;
    handler: (args: unknown, extra: unknown) => Promise<CloudbotToolResult>;
}

function readTextContent(result: CloudbotToolResult): string {
    const content = result.content[0];

    if (content?.type !== 'text') {
        throw new Error('The email tool did not return text.');
    }

    return content.text;
}

const ACCOUNT_SETTINGS: EmailAccountSettings = {
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
};

const ACCOUNT: EmailAccountRecord = {
    botId: 'bot-one',
    ...ACCOUNT_SETTINGS,
    uidValidity: null,
    lastUid: null,
    createdAt: 1,
    updatedAt: 1,
};

function findTool(tools: ToolHandlerFixture[], name: string): ToolHandlerFixture {
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No email tool named ${name}`);
    }

    return found;
}

describe('createEmailTools', () => {
    it('posts the secure password form after approved settings are saved', async () => {
        const saveResult: SaveEmailAccountResult = { account: ACCOUNT, isChanged: true };
        const accountService: Pick<EmailAccountService, 'getAccount' | 'hasPassword' | 'saveSettings'> = {
            getAccount: () => Promise.resolve(ACCOUNT),
            hasPassword: () => false,
            saveSettings: vi.fn(() => Promise.resolve(saveResult)),
        };
        const sender: Pick<SmtpEmailSender, 'send'> = { send: vi.fn(() => Promise.resolve({ ok: true })) };
        const postPasswordForm = vi.fn(() => Promise.resolve(undefined));
        const tools = createEmailTools('bot-one', { accountService, sender, postPasswordForm }) as unknown as ToolHandlerFixture[];

        const result = await findTool(tools, 'email_setup')
            .handler({ ...ACCOUNT_SETTINGS }, {});

        expect(EMAIL_SETUP_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__email_setup');
        expect(readTextContent(result))
            .toContain('secure form');
        expect(postPasswordForm)
            .toHaveBeenCalledWith('bot-one');
        expect(accountService.saveSettings)
            .toHaveBeenCalledWith('bot-one', ACCOUNT_SETTINGS);
    });

    it('reports status without reading a password value', async () => {
        const accountService: Pick<EmailAccountService, 'getAccount' | 'hasPassword' | 'saveSettings'> = {
            getAccount: () => Promise.resolve(ACCOUNT),
            hasPassword: () => true,
            saveSettings: () => Promise.resolve({ account: ACCOUNT, isChanged: false }),
        };
        const sender: Pick<SmtpEmailSender, 'send'> = { send: () => Promise.resolve({ ok: true }) };
        const tools = createEmailTools('bot-one', { accountService, sender, postPasswordForm: () => Promise.resolve(undefined) }) as unknown as ToolHandlerFixture[];

        const result = await findTool(tools, 'email_status')
            .handler({}, {});

        expect(EMAIL_STATUS_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__email_status');
        expect(readTextContent(result))
            .toContain('password saved in the vault');
        expect(readTextContent(result))
            .not.toContain('mailbox-password');
    });

    it('sends the validated message unchanged through the SMTP sender', async () => {
        const accountService: Pick<EmailAccountService, 'getAccount' | 'hasPassword' | 'saveSettings'> = {
            getAccount: () => Promise.resolve(ACCOUNT),
            hasPassword: () => true,
            saveSettings: () => Promise.resolve({ account: ACCOUNT, isChanged: false }),
        };
        const send = vi.fn(() => Promise.resolve({ ok: true }));
        const sender: Pick<SmtpEmailSender, 'send'> = { send };
        const tools = createEmailTools('bot-one', { accountService, sender, postPasswordForm: () => Promise.resolve(undefined) }) as unknown as ToolHandlerFixture[];
        const input = { to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Hello', text: 'Approved body.' };

        const result = await findTool(tools, 'email_send')
            .handler(input, {});

        expect(EMAIL_SEND_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__email_send');
        expect(send)
            .toHaveBeenCalledWith('bot-one', input);
        expect(readTextContent(result))
            .toBe('The email was sent.');
    });
});
