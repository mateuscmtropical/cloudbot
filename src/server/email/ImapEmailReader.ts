import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, FetchOptions, FetchQueryObject, MailboxObject, MessageRangeOptions, SearchObject } from 'imapflow';

import type { EmailAccountRecord } from '../store/EmailAccountStore.ts';
import { parseEmailSource } from './parseEmail.ts';
import type { EmailSkipReason } from './emailMessage.ts';

const INBOX_MAILBOX = 'INBOX';
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGES_PER_POLL = 20;
const CONNECTION_TIMEOUT_MS = 30 * 1000;
const GREETING_TIMEOUT_MS = 15 * 1000;
const SOCKET_TIMEOUT_MS = 60 * 1000;

interface ImapConnectionOptions {
    host: string;
    port: number;
    secure: true;
    auth: { user: string; pass: string };
    tls: { rejectUnauthorized: true };
    logger: false;
    connectionTimeout: number;
    greetingTimeout: number;
    socketTimeout: number;
}

// Only the parts of ImapFlow this reader uses, so a test can pass a fake connection.
interface ImapReaderClient {
    readonly mailbox: MailboxObject | false;
    connect(): Promise<void>;
    logout(): Promise<void>;
    getMailboxLock(mailbox: string): Promise<{ release: () => void }>;
    search(query: SearchObject, options: MessageRangeOptions): Promise<number[] | false | undefined>;
    fetchOne(sequence: string, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false>;
    on(event: string, listener: (...arguments_: unknown[]) => void): unknown;
}

type CreateImapClient = (account: EmailAccountRecord, password: string) => ImapReaderClient;

interface ReadableEmail {
    kind: 'readable';
    uid: number;
    sender: string;
    subject: string;
    receivedAt: string | undefined;
    text: string;
    attachmentCount: number;
}

interface SkippedEmail {
    kind: 'skipped';
    uid: number;
    reason: EmailSkipReason;
}

type IncomingEmail = ReadableEmail | SkippedEmail;

interface EmailBatch {
    uidValidity: string;
    uidNext: number;
    messages: IncomingEmail[];
}

interface EmailReader {
    readNewMessages: (account: EmailAccountRecord, password: string) => Promise<EmailBatch>;
}

interface ImapEmailReaderOptions {
    createClient?: CreateImapClient | undefined;
    maxMessageBytes?: number | undefined;
    maxMessagesPerPoll?: number | undefined;
}

function createImapConnectionOptions(account: EmailAccountRecord, password: string): ImapConnectionOptions {
    return {
        host: account.imapHost,
        port: account.imapPort,
        // Only implicit TLS is accepted. A mailbox on port 143 is refused by its server, never read in plain text.
        secure: true,
        auth: { user: account.username, pass: password },
        tls: { rejectUnauthorized: true },
        logger: false,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
        socketTimeout: SOCKET_TIMEOUT_MS,
    };
}

function createImapClient(account: EmailAccountRecord, password: string): ImapReaderClient {
    const options = createImapConnectionOptions(account, password);

    return new ImapFlow(options);
}

// The server returns the last message for a range that starts past it, so only newer UIDs count.
function selectNewUids(foundUids: number[] | false | undefined, lastUid: number, limit: number): number[] {
    if (!Array.isArray(foundUids)) {
        return [];
    }

    const uniqueUids = [...new Set(foundUids)];

    return uniqueUids.filter(uid => uid > lastUid)
        .sort((left, right) => left - right)
        .slice(0, limit);
}

class ImapEmailReader implements EmailReader {
    private readonly createClient: CreateImapClient;
    private readonly maxMessageBytes: number;
    private readonly maxMessagesPerPoll: number;

    constructor(options: ImapEmailReaderOptions = {}) {
        this.createClient = options.createClient ?? createImapClient;
        this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
        this.maxMessagesPerPoll = options.maxMessagesPerPoll ?? DEFAULT_MAX_MESSAGES_PER_POLL;
    }

    async readNewMessages(account: EmailAccountRecord, password: string): Promise<EmailBatch> {
        const client = this.createClient(account, password);

        // The poller reports a failed poll with the account id. The error object is not logged, since it can hold the address.
        client.on('error', () => undefined);
        await client.connect();

        try {
            const lock = await client.getMailboxLock(INBOX_MAILBOX);

            try {
                const mailbox = client.mailbox;

                if (mailbox === false) {
                    throw new Error('The INBOX could not be opened.');
                }

                const uidValidity = String(mailbox.uidValidity);
                const { lastUid } = account;

                // The first poll only records the position. Old mail is never treated as new.
                if (account.uidValidity !== uidValidity || lastUid === null) {
                    return { uidValidity, uidNext: mailbox.uidNext, messages: [] };
                }

                const range = `${String(lastUid + 1)}:*`;
                const foundUids = await client.search({ uid: range }, { uid: true });
                const newUids = selectNewUids(foundUids, lastUid, this.maxMessagesPerPoll);
                const messages = await this.readMessages(client, newUids);

                return { uidValidity, uidNext: mailbox.uidNext, messages };
            } finally {
                lock.release();
            }
        } finally {
            try {
                await client.logout();
            } catch {
                // The connection may already be gone. The poll's own error is more useful.
            }
        }
    }

    private async readMessages(client: ImapReaderClient, uids: number[]): Promise<IncomingEmail[]> {
        const readOne = async (previous: Promise<IncomingEmail[]>, uid: number): Promise<IncomingEmail[]> => {
            const messages = await previous;
            const message = await this.readMessage(client, uid);

            return [...messages, message];
        };
        const emptyMessages = Promise.resolve<IncomingEmail[]>([]);

        return uids.reduce(readOne, emptyMessages);
    }

    private async readMessage(client: ImapReaderClient, uid: number): Promise<IncomingEmail> {
        const sequence = String(uid);
        const metadata = await client.fetchOne(sequence, { uid: true, size: true }, { uid: true });

        if (metadata === false) {
            return { kind: 'skipped', uid, reason: 'unreadable' };
        }

        const size = metadata.size ?? 0;

        if (size > this.maxMessageBytes) {
            return { kind: 'skipped', uid, reason: 'too-large' };
        }

        const fetched = await client.fetchOne(sequence, { uid: true, source: true }, { uid: true });

        if (fetched === false || fetched.source === undefined) {
            return { kind: 'skipped', uid, reason: 'unreadable' };
        }

        if (fetched.source.length > this.maxMessageBytes) {
            return { kind: 'skipped', uid, reason: 'too-large' };
        }

        try {
            const parsed = await parseEmailSource(fetched.source);

            return { kind: 'readable', uid, ...parsed };
        } catch {
            // A malformed mail must not block every mail behind it.
            return { kind: 'skipped', uid, reason: 'unreadable' };
        }
    }
}

export {
    CONNECTION_TIMEOUT_MS,
    DEFAULT_MAX_MESSAGE_BYTES,
    DEFAULT_MAX_MESSAGES_PER_POLL,
    GREETING_TIMEOUT_MS,
    INBOX_MAILBOX,
    SOCKET_TIMEOUT_MS,
    ImapEmailReader,
    createImapConnectionOptions,
    selectNewUids,
};
export type { CreateImapClient, EmailBatch, EmailReader, ImapEmailReaderOptions, ImapReaderClient, IncomingEmail, ReadableEmail, SkippedEmail };
