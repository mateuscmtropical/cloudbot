import { useEffect, useRef } from 'react';

import { getPushKey, removePushSubscription, savePushSubscription } from './apiClient.ts';
import type { PushSubscriptionInput } from '../shared/pushTypes.ts';

const SERVICE_WORKER_PATH = '/sw.js';
const OPEN_BOT_MESSAGE_TYPE = 'openBot';
const NOTIFICATION_ICON = '/pwa-192.png';
const CONFIRMATION_TEXT = 'Notifications are on.';

// How the attempt ended. Anything but 'enabled' leaves the card open, so the owner can try again.
type PushEnableResult = 'enabled' | 'blocked' | 'unsupported';

// What the switch in the Account panel shows for this browser.
type PushSwitchState = 'on' | 'off' | 'blocked' | 'unsupported';

// The bot a notification opened, and the message it was about.
interface NotificationTarget {
    botId: string;
    messageId?: string | undefined;
}

// The parts of the browser that the steps use. Tests replace them.
interface PushBrowserSubscription {
    options: { applicationServerKey: ArrayBuffer | null };
    toJSON: () => { endpoint?: string | undefined; keys?: Record<string, string> | undefined };
    unsubscribe: () => Promise<boolean>;
}

interface PushBrowserRegistration {
    pushManager: {
        getSubscription: () => Promise<PushBrowserSubscription | null>;
        subscribe: (options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }) => Promise<PushBrowserSubscription>;
    };
    showNotification: (title: string, options: { body: string; icon: string }) => Promise<void>;
}

interface PushClientDeps {
    isSupported: () => boolean;
    requestPermission: () => Promise<NotificationPermission>;
    readPermission: () => NotificationPermission;
    getRegistration: () => Promise<PushBrowserRegistration>;
    fetchPublicKey: () => Promise<string>;
    saveSubscription: (subscription: PushSubscriptionInput) => Promise<void>;
    removeSubscription: (endpoint: string) => Promise<void>;
}

// The server key comes as base64url. atob accepts the missing padding.
function urlBase64ToBytes(text: string): Uint8Array<ArrayBuffer> {
    const base64Text = text.replaceAll('-', '+')
        .replaceAll('_', '/');
    const binaryText = atob(base64Text);
    const bytes = new Uint8Array(binaryText.length);

    binaryText.split('')
        .forEach((character, index) => {
            bytes[index] = character.charCodeAt(0);
        });

    return bytes;
}

function isSameKey(existing: ArrayBuffer | null, wanted: Uint8Array): boolean {
    if (existing === null) {
        return false;
    }

    const existingBytes = new Uint8Array(existing);

    return existingBytes.length === wanted.length && existingBytes.every((byte, index) => byte === wanted[index]);
}

function toSubscriptionInput(subscription: PushBrowserSubscription): PushSubscriptionInput {
    const json = subscription.toJSON();
    const endpoint = json.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;

    if (endpoint === undefined || p256dh === undefined || auth === undefined) {
        throw new Error('The browser gave a subscription without keys.');
    }

    return { endpoint, keys: { p256dh, auth } };
}

function browserDeps(): PushClientDeps {
    return {
        isSupported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
        requestPermission: () => Notification.requestPermission(),
        readPermission: () => Notification.permission,
        getRegistration: async () => {
            const registration = await navigator.serviceWorker.ready;

            return registration;
        },
        fetchPublicKey: async () => {
            const response = await getPushKey();

            return response.publicKey;
        },
        saveSubscription: savePushSubscription,
        removeSubscription: removePushSubscription,
    };
}

// A subscription made with another server key, such as after the key file was lost, cannot be used. It is replaced.
async function reuseOrSubscribe(registration: PushBrowserRegistration, applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushBrowserSubscription> {
    const existing = await registration.pushManager.getSubscription();

    if (existing !== null && isSameKey(existing.options.applicationServerKey, applicationServerKey)) {
        return existing;
    }

    if (existing !== null) {
        await existing.unsubscribe();
    }

    return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}

// Turns notifications on for this browser. The first thing it does is ask for permission, so call it straight from the
// tap on the button. A browser only shows its permission prompt for a tap, and an await before the call can lose the tap.
async function enablePushNotifications(deps: PushClientDeps = browserDeps()): Promise<PushEnableResult> {
    if (!deps.isSupported()) {
        return 'unsupported';
    }

    const permission = await deps.requestPermission();

    if (permission !== 'granted') {
        return 'blocked';
    }

    const [publicKey, registration] = await Promise.all([deps.fetchPublicKey(), deps.getRegistration()]);
    const applicationServerKey = urlBase64ToBytes(publicKey);
    const subscription = await reuseOrSubscribe(registration, applicationServerKey);

    const subscriptionInput = toSubscriptionInput(subscription);

    await deps.saveSubscription(subscriptionInput);
    await registration.showNotification('CloudBot', { body: CONFIRMATION_TEXT, icon: NOTIFICATION_ICON });

    return 'enabled';
}

// Turns notifications off for this browser only. The server forgets the endpoint first. If that fails, the browser keeps
// its subscription, so the owner can tap the button again. A browser with no subscription has nothing to remove.
async function disablePushNotifications(deps: PushClientDeps = browserDeps()): Promise<void> {
    if (!deps.isSupported()) {
        return;
    }

    const registration = await deps.getRegistration();
    const subscription = await registration.pushManager.getSubscription();

    if (subscription === null) {
        return;
    }

    const endpoint = subscription.toJSON().endpoint;

    if (endpoint !== undefined) {
        await deps.removeSubscription(endpoint);
    }

    await subscription.unsubscribe();
}

// Notifications are on in this browser when it may show them and holds a subscription. The server may have dropped an
// expired one, so turning the switch on again always saves the subscription anew.
async function readPushState(deps: PushClientDeps = browserDeps()): Promise<PushSwitchState> {
    if (!deps.isSupported()) {
        return 'unsupported';
    }

    const permission = deps.readPermission();

    if (permission === 'denied') {
        return 'blocked';
    }

    const registration = await deps.getRegistration();
    const subscription = await registration.pushManager.getSubscription();

    return permission === 'granted' && subscription !== null ? 'on' : 'off';
}

// The words for the owner when the card could not turn notifications on.
function describePushResult(result: Exclude<PushEnableResult, 'enabled'>): string {
    if (result === 'blocked') {
        return 'Notifications are blocked for this site. Allow them in the site settings of your browser, then tap the button again.';
    }

    return 'This browser cannot show notifications here. On an iPhone or iPad, add CloudBot to the home screen and open it from there.';
}

// The service worker shows the notifications. It needs a secure page, which is https or localhost.
async function registerServiceWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
        return;
    }

    await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
}

// The bot and message of a link such as /?bot=<id>&message=<id>, which a notification opens when no window is open.
function readNotificationTarget(search: string): NotificationTarget | undefined {
    const parameters = new URLSearchParams(search);
    const botId = parameters.get('bot');
    const messageId = parameters.get('message') ?? undefined;

    if (botId === null || botId === '') {
        return undefined;
    }

    return { botId, messageId };
}

function isOpenBotMessage(data: unknown): data is { type: string; botId: string; messageId?: unknown } {
    return typeof data === 'object' && data !== null && Reflect.get(data, 'type') === OPEN_BOT_MESSAGE_TYPE && typeof Reflect.get(data, 'botId') === 'string';
}

// Tapping a notification while the app is open brings it to the front. The service worker then says which bot to show.
function useNotificationOpen(onOpen: (target: NotificationTarget) => void): void {
    const onOpenRef = useRef(onOpen);

    useEffect(() => {
        onOpenRef.current = onOpen;
    }, [onOpen]);

    useEffect(() => {
        if (!('serviceWorker' in navigator)) {
            return undefined;
        }

        const handleMessage = (event: MessageEvent<unknown>): void => {
            if (isOpenBotMessage(event.data)) {
                const messageId = typeof event.data.messageId === 'string' ? event.data.messageId : undefined;

                onOpenRef.current({ botId: event.data.botId, messageId });
            }
        };
        const container = navigator.serviceWorker;

        container.addEventListener('message', handleMessage);
        // A listener added with addEventListener does not start the message queue by itself.
        container.startMessages();

        return () => {
            container.removeEventListener('message', handleMessage);
        };
    }, []);
}

export { describePushResult, disablePushNotifications, enablePushNotifications, readNotificationTarget, readPushState, registerServiceWorker, urlBase64ToBytes, useNotificationOpen };
export type { NotificationTarget, PushBrowserRegistration, PushBrowserSubscription, PushClientDeps, PushEnableResult, PushSwitchState };
