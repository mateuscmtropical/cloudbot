import type { EmailAccountRecord, EmailAccountStore, EmailCursor } from '../store/EmailAccountStore.ts';
import type { EmailPasswordStore } from './EmailPasswordStore.ts';
import type { EmailBatch, EmailReader, IncomingEmail } from './ImapEmailReader.ts';
import { buildEmailMessage, buildEmailSkipNotice } from './emailMessage.ts';

const EMAIL_POLL_INTERVAL_MS = 60 * 1000;

interface EmailPollerOptions {
    accountStore: Pick<EmailAccountStore, 'list' | 'setBaseline' | 'advanceCursor' | 'claimDelivery' | 'getDelivery' | 'markDeliveryHandled'>;
    passwordStore: Pick<EmailPasswordStore, 'read'>;
    reader: EmailReader;
    // Queues the mail as a routine turn, like a page watch does. The bot answers in its chat.
    sendMessage: (botId: string, text: string, emailDeliveryId: string) => Promise<unknown>;
    // Writes a short system note without starting a turn, for mail that was not read.
    postNotice: (botId: string, text: string, emailDeliveryId: string) => Promise<unknown>;
    isReady?: (() => boolean) | undefined;
    intervalMs?: number | undefined;
}

class EmailPoller {
    private readonly accountStore: EmailPollerOptions['accountStore'];
    private readonly passwordStore: EmailPollerOptions['passwordStore'];
    private readonly reader: EmailReader;
    private readonly sendMessage: EmailPollerOptions['sendMessage'];
    private readonly postNotice: EmailPollerOptions['postNotice'];
    private readonly isReady: () => boolean;
    private readonly intervalMs: number;
    private timer: NodeJS.Timeout | undefined;
    private isPolling = false;

    constructor(options: EmailPollerOptions) {
        this.accountStore = options.accountStore;
        this.passwordStore = options.passwordStore;
        this.reader = options.reader;
        this.sendMessage = options.sendMessage;
        this.postNotice = options.postNotice;
        this.isReady = options.isReady ?? (() => true);
        this.intervalMs = options.intervalMs ?? EMAIL_POLL_INTERVAL_MS;
    }

    start(): void {
        if (this.timer !== undefined) {
            return;
        }

        const runPoll = (): void => {
            this.pollAccounts()
                .catch(() => {
                    console.error('Could not poll the email accounts.');
                });
        };

        this.timer = setInterval(runPoll, this.intervalMs);
        this.timer.unref();
        runPoll();
    }

    stop(): void {
        clearInterval(this.timer);
        this.timer = undefined;
    }

    // Accounts are read in order, and one failing mailbox must not stop the others.
    async pollAccounts(): Promise<void> {
        if (this.isPolling || !this.isReady()) {
            return;
        }

        this.isPolling = true;

        try {
            const accounts = await this.accountStore.list();
            const pollOne = async (previous: Promise<void>, account: EmailAccountRecord): Promise<void> => {
                await previous;
                await this.pollAccount(account);
            };
            const initialPoll = Promise.resolve();

            await accounts.reduce(pollOne, initialPoll);
        } finally {
            this.isPolling = false;
        }
    }

    private async pollAccount(account: EmailAccountRecord): Promise<void> {
        try {
            const password = this.passwordStore.read(account.botId);

            if (password === undefined) {
                return;
            }

            const batch = await this.reader.readNewMessages(account, password);

            await this.applyBatch(account, batch);
        } catch {
            // The account address and the server error are not logged. The bot id is enough to find the mailbox.
            console.error(`Could not poll the email of bot ${account.botId}.`);
        }
    }

    private async applyBatch(account: EmailAccountRecord, batch: EmailBatch): Promise<void> {
        if (account.uidValidity === null || account.lastUid === null || batch.uidValidity !== account.uidValidity) {
            const baseline = Math.max(0, batch.uidNext - 1);
            const previous: EmailCursor = { uidValidity: account.uidValidity, lastUid: account.lastUid };

            await this.accountStore.setBaseline(account.botId, previous, batch.uidValidity, baseline);

            return;
        }

        const uidValidity = batch.uidValidity;
        const handleOne = async (previous: Promise<boolean>, message: IncomingEmail): Promise<boolean> => {
            const shouldContinue = await previous;

            if (!shouldContinue) {
                return false;
            }

            return this.handleMessage(account, uidValidity, message);
        };
        const initialHandle = Promise.resolve(true);

        await batch.messages.reduce(handleOne, initialHandle);
    }

    // The durable claim survives a restart. MessageStore deduplicates the chat entry if the server
    // stopped after posting it but before this row was marked handled.
    private async handleMessage(account: EmailAccountRecord, uidValidity: string, message: IncomingEmail): Promise<boolean> {
        const botId = account.botId;

        await this.accountStore.claimDelivery(botId, uidValidity, message.uid);
        const delivery = await this.accountStore.getDelivery(botId, uidValidity, message.uid);

        if (delivery === undefined) {
            return false;
        }

        if (delivery.handledAt !== null) {
            return this.accountStore.advanceCursor(botId, uidValidity, message.uid);
        }

        const emailDeliveryId = buildEmailDeliveryId(botId, uidValidity, message.uid);

        try {
            if (message.kind === 'skipped') {
                const notice = buildEmailSkipNotice(message.reason);

                await this.postNotice(botId, notice, emailDeliveryId);
            } else {
                const text = buildEmailMessage({
                    address: account.address,
                    sender: message.sender,
                    subject: message.subject,
                    receivedAt: message.receivedAt,
                    text: message.text,
                    attachmentCount: message.attachmentCount,
                });

                await this.sendMessage(botId, text, emailDeliveryId);
            }
        } catch {
            // Keep the claim so the same delivery id is reused on retry after a restart.
            return false;
        }

        const isHandled = await this.accountStore.markDeliveryHandled(botId, uidValidity, message.uid);

        if (!isHandled) {
            return false;
        }

        return this.accountStore.advanceCursor(botId, uidValidity, message.uid);
    }
}

function buildEmailDeliveryId(botId: string, uidValidity: string, uid: number): string {
    return `${botId}:${uidValidity}:${String(uid)}`;
}

export { EMAIL_POLL_INTERVAL_MS, EmailPoller, buildEmailDeliveryId };
export type { EmailPollerOptions };
