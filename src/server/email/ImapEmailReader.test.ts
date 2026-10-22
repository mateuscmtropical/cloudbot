import type { FetchMessageObject, FetchQueryObject, MailboxObject } from 'imapflow';
import { describe, expect, it, vi } from 'vitest';

import type { EmailAccountRecord } from '../store/EmailAccountStore.ts';
import { ImapEmailReader, createImapConnectionOptions, selectNewUids } from './ImapEmailReader.ts';
import type { ImapReaderClient } from './ImapEmailReader.ts';

const ACCOUNT: EmailAccountRecord = {
    botId: 'bot-one',
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
    uidValidity: '7',
    lastUid: 10,
    createdAt: 1,
    updatedAt: 1,
};

class FakeImapReaderClient implements ImapReaderClient {
    readonly mailbox = { uidValidity: 7, uidNext: 12 } as unknown as MailboxObject;
    readonly lockRelease = vi.fn();
    readonly logout = vi.fn(() => Promise.resolve());
    readonly search = vi.fn(() => Promise.resolve([10, 11, 11]));
    readonly fetchOne = vi.fn((_sequence: string, query: FetchQueryObject): Promise<FetchMessageObject | false> => {
        if (Reflect.has(query, 'size')) {
            return Promise.resolve({ uid: 11, size: 80 } as FetchMessageObject);
        }

        const source = Buffer.from('From: Ana <ana@example.com>\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nHi bot.');

        return Promise.resolve({ uid: 11, source, size: source.length } as FetchMessageObject);
    });

    connect(): Promise<void> {
        return Promise.resolve();
    }

    getMailboxLock(mailboxName: string): Promise<{ release: () => void }> {
        expect(mailboxName)
            .toBe('INBOX');

        return Promise.resolve({ release: this.lockRelease });
    }

    on(): unknown {
        return undefined;
    }
}

describe('createImapConnectionOptions', () => {
    it('uses implicit TLS, certificate checks and disables protocol logging', () => {
        expect(createImapConnectionOptions(ACCOUNT, 'mail-password'))
            .toMatchObject({ host: ACCOUNT.imapHost, port: ACCOUNT.imapPort, secure: true, auth: { pass: 'mail-password' }, tls: { rejectUnauthorized: true }, logger: false });
    });
});

describe('selectNewUids', () => {
    it('keeps unique UIDs after the cursor in ascending order and within the poll limit', () => {
        expect(selectNewUids([12, 10, 13, 12, 11], 10, 2))
            .toEqual([11, 12]);
        expect(selectNewUids(false, 10, 2))
            .toEqual([]);
    });
});

describe('ImapEmailReader', () => {
    it('reads only newer mail and releases the lock and connection', async () => {
        const client = new FakeImapReaderClient();
        const reader = new ImapEmailReader({ createClient: () => client });

        const batch = await reader.readNewMessages(ACCOUNT, 'mail-password');

        expect(batch)
            .toEqual({
                uidValidity: '7',
                uidNext: 12,
                messages: [{ kind: 'readable', uid: 11, sender: 'ana@example.com', subject: 'Hello', receivedAt: undefined, text: 'Hi bot.', attachmentCount: 0 }],
            });
        expect(client.search)
            .toHaveBeenCalledWith({ uid: '11:*' }, { uid: true });
        expect(client.lockRelease)
            .toHaveBeenCalledOnce();
        expect(client.logout)
            .toHaveBeenCalledOnce();
    });

    it('records the current position without fetching old inbox mail', async () => {
        const client = new FakeImapReaderClient();
        const reader = new ImapEmailReader({ createClient: () => client });
        const firstAccount = { ...ACCOUNT, uidValidity: null, lastUid: null };

        const batch = await reader.readNewMessages(firstAccount, 'mail-password');

        expect(batch.messages)
            .toEqual([]);
        expect(client.search)
            .not.toHaveBeenCalled();
        expect(client.fetchOne)
            .not.toHaveBeenCalled();
    });
});
