import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import { EmailAccountStore } from '../store/EmailAccountStore.ts';
import type { EmailAccountSettings } from '../store/EmailAccountStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { EmailPoller, buildEmailDeliveryId } from './EmailPoller.ts';
import type { EmailReader, IncomingEmail } from './ImapEmailReader.ts';

const SETTINGS: EmailAccountSettings = {
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
};

const MESSAGE: IncomingEmail = {
    kind: 'readable',
    uid: 11,
    sender: 'ana@example.com',
    subject: 'Hello',
    receivedAt: undefined,
    text: 'Please review this.',
    attachmentCount: 0,
};

describe('EmailPoller', () => {
    let opened: OpenedDatabase;
    let accountStore: EmailAccountStore;
    let botId: string;
    let reader: EmailReader;
    let dataDir: string;
    let databasePath: string;

    beforeEach(async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'cloudbot-email-poller-'));
        databasePath = join(dataDir, 'state.sqlite');
        opened = await openDatabase(databasePath);
        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Mail bot', title: 'Assistant', description: '' });

        botId = bot.id;
        accountStore = new EmailAccountStore(opened.db);
        await accountStore.save(botId, SETTINGS);
        await accountStore.setBaseline(botId, { uidValidity: null, lastUid: null }, 'v1', 10);
        reader = {
            readNewMessages: account => Promise.resolve({
                uidValidity: 'v1',
                uidNext: 12,
                messages: account.lastUid === 10 ? [MESSAGE] : [],
            }),
        };
    });

    afterEach(() => {
        opened.close();
        rmSync(dataDir, { recursive: true, force: true });
    });

    it('retries an unfinished delivery after a restart with the same id and advances once', async () => {
        const sendMessage = vi.fn(() => Promise.reject(new Error('fake queue failure')));
        const passwordStore = { read: vi.fn(() => 'fake-password') };
        const firstRun = new EmailPoller({
            accountStore,
            passwordStore,
            reader,
            sendMessage,
            postNotice: vi.fn(() => Promise.resolve(undefined)),
        });

        await firstRun.pollAccounts();

        const unhandled = await accountStore.getDelivery(botId, 'v1', 11);

        expect(unhandled?.handledAt)
            .toBeNull();
        await expect(accountStore.get(botId))
            .resolves.toMatchObject({ lastUid: 10 });

        opened.close();
        opened = await openDatabase(databasePath);
        accountStore = new EmailAccountStore(opened.db);
        const retrySend = vi.fn(() => Promise.resolve(undefined));
        const restartedRun = new EmailPoller({
            accountStore,
            passwordStore,
            reader,
            sendMessage: retrySend,
            postNotice: vi.fn(() => Promise.resolve(undefined)),
        });

        await restartedRun.pollAccounts();

        expect(sendMessage)
            .toHaveBeenCalledWith(botId, expect.stringContaining('Please review this.'), buildEmailDeliveryId(botId, 'v1', 11));
        expect(retrySend)
            .toHaveBeenCalledWith(botId, expect.stringContaining('Please review this.'), buildEmailDeliveryId(botId, 'v1', 11));
        const handledDelivery = await accountStore.getDelivery(botId, 'v1', 11);

        expect(handledDelivery)
            .toBeDefined();
        expect(handledDelivery?.handledAt)
            .toBeTypeOf('number');
        await expect(accountStore.get(botId))
            .resolves.toMatchObject({ lastUid: 11 });
    });

    it('records the current inbox position without delivering old messages', async () => {
        const saved = await accountStore.save(botId, { ...SETTINGS, address: 'other@example.com' });
        const cleanAccount = new EmailAccountStore(opened.db);

        expect(saved.isChanged)
            .toBe(true);

        const readNewMessages = vi.fn(() => Promise.resolve({ uidValidity: 'v1', uidNext: 12, messages: [MESSAGE] }));
        const baselineReader: EmailReader = { readNewMessages };
        const sendMessage = vi.fn(() => Promise.resolve(undefined));
        const poller = new EmailPoller({
            accountStore: cleanAccount,
            passwordStore: { read: vi.fn(() => 'fake-password') },
            reader: baselineReader,
            sendMessage,
            postNotice: vi.fn(() => Promise.resolve(undefined)),
        });

        await poller.pollAccounts();

        expect(sendMessage)
            .not.toHaveBeenCalled();
        await expect(cleanAccount.get(botId))
            .resolves.toMatchObject({ uidValidity: 'v1', lastUid: 11 });
    });

    it('does not open a mailbox until the secure form has saved a password', async () => {
        const readNewMessages = vi.fn(() => Promise.resolve({ uidValidity: 'v1', uidNext: 12, messages: [MESSAGE] }));
        const poller = new EmailPoller({
            accountStore,
            passwordStore: { read: vi.fn(() => undefined) },
            reader: { readNewMessages },
            sendMessage: vi.fn(() => Promise.resolve(undefined)),
            postNotice: vi.fn(() => Promise.resolve(undefined)),
        });

        await poller.pollAccounts();

        expect(readNewMessages)
            .not.toHaveBeenCalled();
    });
});
