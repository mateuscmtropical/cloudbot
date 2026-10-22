import { describe, expect, it, vi } from 'vitest';

import type { EmailAccountSettings, SaveEmailAccountResult } from '../store/EmailAccountStore.ts';
import { EmailAccountService } from './EmailAccountService.ts';

interface PasswordFixture {
    isSet: (botId: string) => boolean;
    read: (botId: string) => string | undefined;
    save: (botId: string, password: string) => void;
    remove: (botId: string) => void;
}

const SETTINGS: EmailAccountSettings = {
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
};

describe('EmailAccountService', () => {
    it('clears the old password when mailbox settings change', async () => {
        const account = { botId: 'bot-one', ...SETTINGS, uidValidity: null, lastUid: null, createdAt: 1, updatedAt: 1 };
        const saveResult: SaveEmailAccountResult = { account, isChanged: true };
        const save = vi.fn(() => Promise.resolve(saveResult));
        const remove = vi.fn();
        const passwords: PasswordFixture = {
            isSet: vi.fn(() => true),
            read: vi.fn(() => 'private'),
            save: vi.fn(() => undefined),
            remove,
        };
        const service = new EmailAccountService({ get: vi.fn(() => Promise.resolve(account)), save }, passwords);

        await expect(service.saveSettings('bot-one', SETTINGS))
            .resolves.toEqual(saveResult);

        expect(remove)
            .toHaveBeenCalledWith('bot-one');
        expect(service.readPassword('bot-one'))
            .toBe('private');
    });

    it('keeps the existing password when settings are unchanged', async () => {
        const account = { botId: 'bot-one', ...SETTINGS, uidValidity: null, lastUid: null, createdAt: 1, updatedAt: 1 };
        const saveResult: SaveEmailAccountResult = { account, isChanged: false };
        const remove = vi.fn();
        const passwords: PasswordFixture = {
            isSet: vi.fn(() => true),
            read: vi.fn(() => undefined),
            save: vi.fn(() => undefined),
            remove,
        };
        const service = new EmailAccountService({ get: vi.fn(() => Promise.resolve(account)), save: vi.fn(() => Promise.resolve(saveResult)) }, passwords);

        await service.saveSettings('bot-one', SETTINGS);

        expect(remove)
            .not.toHaveBeenCalled();
        expect(service.hasPassword('bot-one'))
            .toBe(true);
    });
});
