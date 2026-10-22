import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeClient {
    url: string;
    visibilityState: 'visible' | 'hidden';
    focus: ReturnType<typeof vi.fn<() => Promise<void>>>;
    postMessage: ReturnType<typeof vi.fn<(message: unknown) => void>>;
}

type Listener = (event: unknown) => void;

interface FakeNotificationData {
    botId?: string;
    messageId?: string;
}

interface ShownNotification {
    title: string;
    options: { body: string; tag: string; renotify: boolean; silent: boolean; icon: string; data: FakeNotificationData };
    close: ReturnType<typeof vi.fn<() => void>>;
}

const SERVICE_WORKER_SOURCE = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'public', 'sw.js'), 'utf8');

function createClient(url: string, visibilityState: 'visible' | 'hidden'): FakeClient {
    return { url, visibilityState, focus: vi.fn(() => Promise.resolve()), postMessage: vi.fn() };
}

// Runs the real file against a fake worker scope, so the test reads what the browser would run.
function loadServiceWorker(clients: FakeClient[]): {
    listeners: Map<string, Listener>;
    shown: ShownNotification[];
    openWindow: ReturnType<typeof vi.fn<(address: string) => Promise<void>>>;
    skipWaiting: ReturnType<typeof vi.fn<() => void>>;
} {
    const listeners = new Map<string, Listener>();
    const shown: ShownNotification[] = [];
    const openWindow = vi.fn<(address: string) => Promise<void>>(() => Promise.resolve());
    const skipWaiting = vi.fn<() => void>();
    const scope = {
        addEventListener: (type: string, listener: Listener) => {
            listeners.set(type, listener);
        },
        skipWaiting,
        clients: { matchAll: () => Promise.resolve(clients), openWindow },
        registration: {
            showNotification: (title: string, options: ShownNotification['options']) => {
                shown.push({ title, options, close: vi.fn() });

                return Promise.resolve();
            },
            // Like the browser, it returns the notifications that are open with the tag.
            getNotifications: (filter: { tag: string }) => Promise.resolve(shown.filter(item => item.options.tag === filter.tag)
                .map(item => ({ close: item.close }))),
        },
    };

    runInNewContext(SERVICE_WORKER_SOURCE, { self: scope, URL, encodeURIComponent });

    return { listeners, shown, openWindow, skipWaiting };
}

interface PushEventFake {
    data: { json: () => unknown } | null;
    waitUntil: ReturnType<typeof vi.fn<(work: Promise<unknown>) => void>>;
}

function createPushEvent(payload: unknown): PushEventFake {
    return { data: { json: () => payload }, waitUntil: vi.fn() };
}

async function deliverPush(listeners: Map<string, Listener>, event: PushEventFake): Promise<void> {
    listeners.get('push')?.(event);

    await Promise.all(event.waitUntil.mock.calls.map(call => call[0]));
}

const NOTICE = { title: 'Ana', body: 'Finished its work.', kind: 'done', botId: 'bot-1', messageId: 'message-4' };

describe('service worker push', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('shows the notice when no window is open', async () => {
        const { listeners, shown } = loadServiceWorker([]);

        await deliverPush(listeners, createPushEvent(NOTICE));

        expect(shown)
            .toHaveLength(1);
        expect(shown[0]?.title)
            .toBe('Ana');
        expect(shown[0]?.options)
            .toMatchObject({ body: 'Finished its work.', tag: 'bot-1:done', renotify: true, data: { botId: 'bot-1', messageId: 'message-4' } });
    });

    it('shows the notice without sound and closes it at once when a visible window already shows that bot', async () => {
        const { listeners, shown } = loadServiceWorker([createClient('https://bot.example.com/?bot=bot-1', 'visible')]);

        await deliverPush(listeners, createPushEvent(NOTICE));

        // Safari revokes a subscription whose pushes end without a visible notification, so one is always shown.
        expect(shown)
            .toHaveLength(1);
        expect(shown[0]?.options)
            .toMatchObject({ silent: true, renotify: false, tag: 'bot-1:done' });
        expect(shown[0]?.close)
            .toHaveBeenCalledTimes(1);
    });

    it('keeps the notification open and with sound when no visible window shows the bot', async () => {
        const { listeners, shown } = loadServiceWorker([createClient('https://bot.example.com/?bot=bot-2', 'visible')]);

        await deliverPush(listeners, createPushEvent(NOTICE));

        expect(shown[0]?.options)
            .toMatchObject({ silent: false, renotify: true });
        expect(shown[0]?.close)
            .not.toHaveBeenCalled();
    });

    it.each([
        ['a hidden window of that bot', 'https://bot.example.com/?bot=bot-1', 'hidden'],
        ['a visible window of another bot', 'https://bot.example.com/?bot=bot-2', 'visible'],
        ['a visible window that shows no bot yet', 'https://bot.example.com/', 'visible'],
    ] as const)('still shows the notice with %s', async (_label, url, visibility) => {
        const { listeners, shown } = loadServiceWorker([createClient(url, visibility)]);

        await deliverPush(listeners, createPushEvent(NOTICE));

        expect(shown)
            .toHaveLength(1);
    });

    it.each([
        ['an empty push', null],
        ['a payload without a bot', { title: 'Ana', body: 'x', kind: 'done' }],
        ['a payload with a number title', { title: 5, body: 'x', kind: 'done', botId: 'bot-1' }],
        ['text that is not an object', 'hello'],
    ])('ignores %s', async (_label, payload) => {
        const { listeners, shown } = loadServiceWorker([]);
        const event: PushEventFake = payload === null ? { data: null, waitUntil: vi.fn() } : createPushEvent(payload);

        await deliverPush(listeners, event);

        expect(shown)
            .toEqual([]);
    });

    it('ignores a push whose data is not JSON', async () => {
        const { listeners, shown } = loadServiceWorker([]);
        const failingJson = (): unknown => {
            throw new SyntaxError('bad');
        };
        const event: PushEventFake = { data: { json: failingJson }, waitUntil: vi.fn() };

        await deliverPush(listeners, event);

        expect(shown)
            .toEqual([]);
    });

    it('takes over at once when it is installed', () => {
        const { listeners, skipWaiting } = loadServiceWorker([]);

        listeners.get('install')?.({});

        expect(skipWaiting)
            .toHaveBeenCalledTimes(1);
    });
});

describe('service worker notification click', () => {
    function createClick(data: FakeNotificationData | null): { notification: { close: ReturnType<typeof vi.fn<() => void>>; data: FakeNotificationData | null }; waitUntil: ReturnType<typeof vi.fn<(work: Promise<unknown>) => void>> } {
        return { notification: { close: vi.fn(), data }, waitUntil: vi.fn() };
    }

    async function click(listeners: Map<string, Listener>, data: FakeNotificationData | null): Promise<ReturnType<typeof createClick>> {
        const event = createClick(data);

        listeners.get('notificationclick')?.(event);
        await Promise.all(event.waitUntil.mock.calls.map(call => call[0]));

        return event;
    }

    it('opens a new window at the bot and message when no window is open', async () => {
        const { listeners, openWindow } = loadServiceWorker([]);
        const event = await click(listeners, { botId: 'bot-1', messageId: 'message 4' });

        expect(event.notification.close)
            .toHaveBeenCalled();
        expect(openWindow)
            .toHaveBeenCalledWith('/?bot=bot-1&message=message%204');
    });

    it('opens the bot without a message when the notice has none', async () => {
        const { listeners, openWindow } = loadServiceWorker([]);

        await click(listeners, { botId: 'bot-1' });

        expect(openWindow)
            .toHaveBeenCalledWith('/?bot=bot-1');
    });

    it('brings the window of that bot to the front and tells it what to show', async () => {
        const other = createClient('https://bot.example.com/?bot=bot-2', 'visible');
        const same = createClient('https://bot.example.com/?bot=bot-1', 'hidden');
        const { listeners, openWindow } = loadServiceWorker([other, same]);

        await click(listeners, { botId: 'bot-1', messageId: 'message-4' });

        expect(same.focus)
            .toHaveBeenCalled();
        expect(same.postMessage)
            .toHaveBeenCalledWith({ type: 'openBot', botId: 'bot-1', messageId: 'message-4' });
        expect(other.focus)
            .not.toHaveBeenCalled();
        expect(openWindow)
            .not.toHaveBeenCalled();
    });

    it('uses another open window when none shows that bot', async () => {
        const other = createClient('https://bot.example.com/?bot=bot-2', 'visible');
        const { listeners, openWindow } = loadServiceWorker([other]);

        await click(listeners, { botId: 'bot-1' });

        expect(other.postMessage)
            .toHaveBeenCalledWith({ type: 'openBot', botId: 'bot-1', messageId: undefined });
        expect(openWindow)
            .not.toHaveBeenCalled();
    });

    it('does nothing for a notification without a bot', async () => {
        const client = createClient('https://bot.example.com/?bot=bot-2', 'visible');
        const { listeners, openWindow } = loadServiceWorker([client]);

        await click(listeners, null);

        expect(client.focus)
            .not.toHaveBeenCalled();
        expect(openWindow)
            .not.toHaveBeenCalled();
    });
});
