// The service worker of the web app. It shows push notifications and opens the right bot when one is tapped.
// It caches nothing, so the app always comes from the server. It makes no network request of its own.

const OPEN_BOT_MESSAGE_TYPE = 'openBot';
const NOTIFICATION_ICON = '/pwa-192.png';

function readBotId(address) {
    return new URL(address).searchParams.get('bot');
}

// The push is the JSON of a notice from the server. Anything else is ignored, so a malformed push shows nothing.
function readNotice(event) {
    if (event.data === null) {
        return undefined;
    }

    try {
        const notice = event.data.json();
        const isNotice = typeof notice.botId === 'string' && typeof notice.title === 'string' && typeof notice.body === 'string' && typeof notice.kind === 'string';

        return isNotice ? notice : undefined;
    } catch {
        return undefined;
    }
}

function listWindows() {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

// A tab that shows this bot right now already has the event in front of the owner. The notification is still shown and
// then closed at once, without sound. WebKit (Safari) needs every push to end in a visible notification, and it revokes
// the subscription of a site that answers too many pushes with none. Any other tab, hidden or showing another bot,
// keeps the notification.
async function showNotice(notice) {
    const windows = await listWindows();
    const isWatching = windows.some(client => client.visibilityState === 'visible' && readBotId(client.url) === notice.botId);
    // One notification for each bot and kind. A newer one replaces the older one and alerts again.
    const tag = `${notice.botId}:${notice.kind}`;

    await self.registration.showNotification(notice.title, {
        body: notice.body,
        icon: NOTIFICATION_ICON,
        tag,
        renotify: !isWatching,
        silent: isWatching,
        data: { botId: notice.botId, messageId: notice.messageId },
    });

    if (isWatching) {
        const shown = await self.registration.getNotifications({ tag });

        shown.forEach((notification) => {
            notification.close();
        });
    }
}

function buildOpenAddress(target) {
    const messagePart = typeof target.messageId === 'string' ? `&message=${encodeURIComponent(target.messageId)}` : '';

    return `/?bot=${encodeURIComponent(target.botId)}${messagePart}`;
}

// Opens a window when none is open. Otherwise it brings one to the front and tells it which bot and message to show.
async function openTarget(target) {
    if (typeof target.botId !== 'string') {
        return;
    }

    const windows = await listWindows();
    const sameBotWindow = windows.find(client => readBotId(client.url) === target.botId);
    const windowToUse = sameBotWindow ?? windows[0];

    if (windowToUse === undefined) {
        const address = buildOpenAddress(target);

        await self.clients.openWindow(address);

        return;
    }

    await windowToUse.focus();
    windowToUse.postMessage({ type: OPEN_BOT_MESSAGE_TYPE, botId: target.botId, messageId: target.messageId });
}

// A new version takes over at once. There is no cache to keep in step.
self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('push', (event) => {
    const notice = readNotice(event);

    if (notice !== undefined) {
        const shown = showNotice(notice);

        event.waitUntil(shown);
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const opened = openTarget(event.notification.data ?? {});

    event.waitUntil(opened);
});
