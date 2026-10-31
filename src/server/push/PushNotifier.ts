import type { PushSubscriptionRecord, PushSubscriptionStore } from '../store/PushSubscriptionStore.ts';
import type { PushNotice, PushNoticeKind } from '../../shared/pushTypes.ts';
import type { PushSender } from './createPushSender.ts';
import { toNoticeLine } from './noticeLine.ts';
import { buildVapidAuthorization, encryptPushPayload } from './webPushCrypto.ts';
import type { VapidKeyPair } from './webPushCrypto.ts';

// What happened, for which bot, and the message the owner should see.
interface OwnerNotice {
    kind: PushNoticeKind;
    botId: string;
    botName: string;
    messageId: string | undefined;
    // The line to show, such as the first line of the reply. Without it the notification shows the plain line of its kind.
    body?: string | undefined;
}

interface PushNotifierOptions {
    store: PushSubscriptionStore;
    keys: VapidKeyPair;
    send: PushSender;
    // The contact that VAPID names, an https address or a mailto address.
    subject: string;
    now?: () => number;
}

// The plain line of each kind, for a notice without its own line. The text is encrypted, so the push service sees only
// the size and timing of each push.
const NOTICE_LINES: Record<PushNoticeKind, string> = {
    done: 'Finished its work.',
    approval: 'Waiting for your approval.',
    screen: 'Needs you on its screen.',
};

// The push service keeps a notification that could not be delivered for this long, and then drops it.
const TTL_SECONDS = 60 * 60;
const GONE_STATUSES = [404, 410];
const MS_PER_SECOND = 1000;
// A bot that answers many short turns would buzz the phone for each. One push of this kind in a minute is enough.
const DONE_PUSH_INTERVAL_MS = 60 * MS_PER_SECOND;
// A long name is cut. With the body line, the payload stays far under the 4 KB a push can carry.
const MAX_TITLE_CHARACTERS = 40;

function buildPushNotice(notice: OwnerNotice): PushNotice {
    const bodyLine = notice.body === undefined ? undefined : toNoticeLine(notice.body);

    return {
        title: Array.from(notice.botName)
            .slice(0, MAX_TITLE_CHARACTERS)
            .join(''),
        body: bodyLine ?? NOTICE_LINES[notice.kind],
        kind: notice.kind,
        botId: notice.botId,
        // Without a message the click opens the bot at its newest message.
        ...(notice.messageId === undefined ? {} : { messageId: notice.messageId }),
    };
}

class PushNotifier {
    private readonly store: PushSubscriptionStore;
    private readonly keys: VapidKeyPair;
    private readonly send: PushSender;
    private readonly subject: string;
    private readonly now: () => number;
    private readonly lastDonePushes = new Map<string, number>();

    constructor(options: PushNotifierOptions) {
        this.store = options.store;
        this.keys = options.keys;
        this.send = options.send;
        this.subject = options.subject;
        this.now = options.now ?? (() => Date.now());
    }

    // The public half of the key. The browser needs it to subscribe.
    get publicKey(): string {
        return this.keys.publicKey;
    }

    // Sends the notice to every subscribed browser. One failing browser never stops the others, and nothing is thrown.
    async notify(notice: OwnerNotice): Promise<void> {
        if (notice.kind === 'done' && !this.takeDoneSlot(notice.botId)) {
            return;
        }

        const subscriptions = await this.store.list();

        if (subscriptions.length === 0) {
            return;
        }

        const pushNotice = buildPushNotice(notice);
        const noticeText = JSON.stringify(pushNotice);
        const payload = Buffer.from(noticeText, 'utf8');
        const deliveries = subscriptions.map(subscription => this.deliver(subscription, payload));

        await Promise.all(deliveries);
    }

    // At most one done push for each bot in a minute. An approval or a screen hand-off always goes, since the bot waits.
    private takeDoneSlot(botId: string): boolean {
        const currentTime = this.now();
        const lastTime = this.lastDonePushes.get(botId);

        if (lastTime !== undefined && currentTime - lastTime < DONE_PUSH_INTERVAL_MS) {
            return false;
        }

        this.lastDonePushes.set(botId, currentTime);

        return true;
    }

    private async deliver(subscription: PushSubscriptionRecord, payload: Buffer): Promise<void> {
        try {
            const body = encryptPushPayload(payload, { p256dh: subscription.p256dh, auth: subscription.auth });
            const audience = new URL(subscription.endpoint).origin;
            const authorization = buildVapidAuthorization(this.keys, { audience, subject: this.subject, nowSeconds: Math.floor(this.now() / MS_PER_SECOND) });
            const status = await this.send({
                endpoint: subscription.endpoint,
                headers: {
                    'Authorization': authorization,
                    'Content-Encoding': 'aes128gcm',
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': String(body.length),
                    'TTL': String(TTL_SECONDS),
                },
                body,
            });

            if (GONE_STATUSES.includes(status)) {
                // The browser dropped this subscription, so it can never receive a push again.
                await this.store.remove(subscription.endpoint);

                return;
            }

            if (status < 200 || status >= 300) {
                console.error(`A push service refused a notification with status ${String(status)}.`);
            }
        } catch {
            // The log never names the endpoint or the error, since both can carry the address of the browser.
            console.error('A push notification could not be sent.');
        }
    }
}

export { NOTICE_LINES, PushNotifier, buildPushNotice };
export type { OwnerNotice, PushNotifierOptions };
