// What the bot did that the owner may want to hear about while the web app is closed or in the background.
type PushNoticeKind = 'done' | 'approval' | 'screen';

// The JSON inside an encrypted push. The service worker reads it and shows the notification.
interface PushNotice {
    // The name of the bot.
    title: string;
    // One short line, such as the first line of the reply or the line the bot set for the notification.
    body: string;
    kind: PushNoticeKind;
    botId: string;
    // The message to open. Missing means the newest message of the bot.
    messageId?: string;
}

// The public half of the server key. The browser passes it to the push service when it subscribes.
interface PushKeyResponse {
    publicKey: string;
}

interface PushSubscriptionKeys {
    p256dh: string;
    auth: string;
}

// The browser to forget. The endpoint is the identity of a subscription.
interface PushUnsubscribeInput {
    endpoint: string;
}

// The subscription of one browser, as PushSubscription.toJSON gives it.
interface PushSubscriptionInput {
    endpoint: string;
    keys: PushSubscriptionKeys;
}

// The id of the answer that turns notifications on in a notification card.
const ENABLE_NOTIFICATIONS_CHOICE_ID = 'enable';
const LATER_NOTIFICATIONS_CHOICE_ID = 'later';
// The ids of the answers of the card that turns them off for this browser.
const DISABLE_NOTIFICATIONS_CHOICE_ID = 'disable';
const KEEP_NOTIFICATIONS_CHOICE_ID = 'keep';

export { DISABLE_NOTIFICATIONS_CHOICE_ID, ENABLE_NOTIFICATIONS_CHOICE_ID, KEEP_NOTIFICATIONS_CHOICE_ID, LATER_NOTIFICATIONS_CHOICE_ID };
export type { PushKeyResponse, PushNotice, PushNoticeKind, PushSubscriptionInput, PushSubscriptionKeys, PushUnsubscribeInput };
