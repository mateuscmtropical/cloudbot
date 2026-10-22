// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describePushResult, disablePushNotifications, enablePushNotifications, readNotificationTarget, registerServiceWorker, urlBase64ToBytes, useNotificationOpen } from './pushClient.ts';
import type { PushBrowserRegistration, PushBrowserSubscription, PushClientDeps } from './pushClient.ts';

const SERVER_KEY_TEXT = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';

interface FakeBrowser {
    deps: PushClientDeps;
    requestPermission: ReturnType<typeof vi.fn<() => Promise<NotificationPermission>>>;
    saveSubscription: ReturnType<typeof vi.fn<PushClientDeps['saveSubscription']>>;
    removeSubscription: ReturnType<typeof vi.fn<PushClientDeps['removeSubscription']>>;
    subscribe: ReturnType<typeof vi.fn<PushBrowserRegistration['pushManager']['subscribe']>>;
    showNotification: ReturnType<typeof vi.fn<PushBrowserRegistration['showNotification']>>;
}

function createSubscription(key: Uint8Array | null, endpoint = 'https://fcm.googleapis.com/fcm/send/abc'): PushBrowserSubscription {
    const keyBuffer = key === null ? null : new Uint8Array(key).buffer;

    return {
        options: { applicationServerKey: keyBuffer },
        toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-text', auth: 'auth-text' } }),
        unsubscribe: vi.fn(() => Promise.resolve(true)),
    };
}

function createFakeBrowser(options: { permission?: NotificationPermission; existing?: PushBrowserSubscription | null; isSupported?: boolean } = {}): FakeBrowser {
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>(() => Promise.resolve(options.permission ?? 'granted'));
    const saveSubscription = vi.fn<PushClientDeps['saveSubscription']>(() => Promise.resolve());
    const removeSubscription = vi.fn<PushClientDeps['removeSubscription']>(() => Promise.resolve());
    const subscribe = vi.fn<PushBrowserRegistration['pushManager']['subscribe']>(() => Promise.resolve(createSubscription(urlBase64ToBytes(SERVER_KEY_TEXT))));
    const showNotification = vi.fn<PushBrowserRegistration['showNotification']>(() => Promise.resolve());
    const registration: PushBrowserRegistration = {
        pushManager: { getSubscription: () => Promise.resolve(options.existing ?? null), subscribe },
        showNotification,
    };
    const deps: PushClientDeps = {
        isSupported: () => options.isSupported ?? true,
        requestPermission,
        getRegistration: () => Promise.resolve(registration),
        fetchPublicKey: () => Promise.resolve(SERVER_KEY_TEXT),
        saveSubscription,
        removeSubscription,
    };

    return { deps, requestPermission, saveSubscription, removeSubscription, subscribe, showNotification };
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('urlBase64ToBytes', () => {
    it('decodes base64url text without padding into the 65 bytes of a P-256 key', () => {
        const bytes = urlBase64ToBytes(SERVER_KEY_TEXT);

        expect(bytes)
            .toHaveLength(65);
        expect(bytes[0])
            .toBe(4);
        expect(Array.from(urlBase64ToBytes('-_-_')))
            .toEqual([251, 255, 191]);
    });
});

describe('enablePushNotifications', () => {
    it('asks for permission first, subscribes with the server key, saves the subscription and confirms', async () => {
        const browser = createFakeBrowser();
        const result = await enablePushNotifications(browser.deps);

        expect(result)
            .toBe('enabled');
        expect(browser.subscribe)
            .toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(SERVER_KEY_TEXT) });
        expect(browser.saveSubscription)
            .toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p256dh-text', auth: 'auth-text' } });
        expect(browser.showNotification)
            .toHaveBeenCalledWith('CloudBot', expect.objectContaining({ body: 'Notifications are on.' }));
    });

    it('calls requestPermission before any await, so it runs inside the tap', () => {
        const browser = createFakeBrowser();

        void enablePushNotifications(browser.deps);

        expect(browser.requestPermission)
            .toHaveBeenCalledTimes(1);
    });

    it.each<NotificationPermission>(['denied', 'default'])('stops without subscribing when the permission is %s', async (permission) => {
        const browser = createFakeBrowser({ permission });
        const result = await enablePushNotifications(browser.deps);

        expect(result)
            .toBe('blocked');
        expect(browser.subscribe)
            .not.toHaveBeenCalled();
        expect(browser.saveSubscription)
            .not.toHaveBeenCalled();
    });

    it('reports a browser that has no push support, without asking for permission', async () => {
        const browser = createFakeBrowser({ isSupported: false });
        const result = await enablePushNotifications(browser.deps);

        expect(result)
            .toBe('unsupported');
        expect(browser.requestPermission)
            .not.toHaveBeenCalled();
    });

    it('reuses a subscription that was made with the same server key', async () => {
        const existing = createSubscription(urlBase64ToBytes(SERVER_KEY_TEXT));
        const browser = createFakeBrowser({ existing });
        const result = await enablePushNotifications(browser.deps);

        expect(result)
            .toBe('enabled');
        expect(browser.subscribe)
            .not.toHaveBeenCalled();
        expect(existing.unsubscribe)
            .not.toHaveBeenCalled();
        expect(browser.saveSubscription)
            .toHaveBeenCalledTimes(1);
    });

    it('replaces a subscription that was made with another server key', async () => {
        const filledKey = new Uint8Array(65);

        filledKey.fill(9);
        const existing = createSubscription(filledKey);
        const browser = createFakeBrowser({ existing });
        const result = await enablePushNotifications(browser.deps);

        expect(result)
            .toBe('enabled');
        expect(existing.unsubscribe)
            .toHaveBeenCalledTimes(1);
        expect(browser.subscribe)
            .toHaveBeenCalledTimes(1);
    });

    it('fails without saving when the browser gives a subscription without keys', async () => {
        const browser = createFakeBrowser();
        const keyless: PushBrowserSubscription = { ...createSubscription(null), toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }) };

        browser.subscribe.mockResolvedValue(keyless);

        await expect(enablePushNotifications(browser.deps))
            .rejects.toThrow('without keys');
        expect(browser.saveSubscription)
            .not.toHaveBeenCalled();
    });

    it('does not confirm when the server refuses the subscription', async () => {
        const browser = createFakeBrowser();

        browser.saveSubscription.mockRejectedValue(new Error('refused'));

        await expect(enablePushNotifications(browser.deps))
            .rejects.toThrow('refused');
        expect(browser.showNotification)
            .not.toHaveBeenCalled();
    });
});

describe('disablePushNotifications', () => {
    it('removes the endpoint from the server and then from the browser', async () => {
        const existing = createSubscription(urlBase64ToBytes(SERVER_KEY_TEXT), 'https://fcm.googleapis.com/fcm/send/mine');
        const browser = createFakeBrowser({ existing });

        await disablePushNotifications(browser.deps);

        expect(browser.removeSubscription)
            .toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/mine');
        expect(existing.unsubscribe)
            .toHaveBeenCalledTimes(1);
    });

    it('keeps the browser subscription when the server could not remove it, so the owner can try again', async () => {
        const existing = createSubscription(urlBase64ToBytes(SERVER_KEY_TEXT));
        const browser = createFakeBrowser({ existing });

        browser.removeSubscription.mockRejectedValue(new Error('offline'));

        await expect(disablePushNotifications(browser.deps))
            .rejects.toThrow('offline');
        expect(existing.unsubscribe)
            .not.toHaveBeenCalled();
    });

    it('does nothing when this browser has no subscription', async () => {
        const browser = createFakeBrowser({ existing: null });

        await disablePushNotifications(browser.deps);

        expect(browser.removeSubscription)
            .not.toHaveBeenCalled();
    });

    it('does nothing in a browser without push support', async () => {
        const browser = createFakeBrowser({ isSupported: false });

        await disablePushNotifications(browser.deps);

        expect(browser.removeSubscription)
            .not.toHaveBeenCalled();
    });
});

describe('describePushResult', () => {
    it('tells the owner how to unblock the site and what to do on an iPhone', () => {
        expect(describePushResult('blocked'))
            .toContain('site settings');
        expect(describePushResult('unsupported'))
            .toContain('home screen');
    });
});

describe('readNotificationTarget', () => {
    it('reads the bot and the message of the address', () => {
        expect(readNotificationTarget('?bot=bot-1&message=message-2'))
            .toEqual({ botId: 'bot-1', messageId: 'message-2' });
        expect(readNotificationTarget('?bot=bot-1'))
            .toEqual({ botId: 'bot-1', messageId: undefined });
    });

    it('returns nothing when the address names no bot', () => {
        expect(readNotificationTarget(''))
            .toBeUndefined();
        expect(readNotificationTarget('?message=message-2'))
            .toBeUndefined();
        expect(readNotificationTarget('?bot='))
            .toBeUndefined();
    });
});

describe('registerServiceWorker', () => {
    it('registers the worker at the root', async () => {
        const register = vi.fn(() => Promise.resolve(undefined));

        vi.stubGlobal('navigator', { serviceWorker: { register } });

        await registerServiceWorker();

        expect(register)
            .toHaveBeenCalledWith('/sw.js');
    });

    it('does nothing in a browser without service workers', async () => {
        vi.stubGlobal('navigator', {});

        await expect(registerServiceWorker())
            .resolves.toBeUndefined();
    });
});

describe('useNotificationOpen', () => {
    function createServiceWorkerContainer(): { container: EventTarget & { startMessages: () => void }; send: (data: unknown) => void } {
        const container = Object.assign(new EventTarget(), { startMessages: vi.fn() });

        return {
            container,
            send: (data) => {
                container.dispatchEvent(new MessageEvent('message', { data }));
            },
        };
    }

    it('reports the bot and message that the service worker names', () => {
        const { container, send } = createServiceWorkerContainer();
        const onOpen = vi.fn();

        vi.stubGlobal('navigator', { serviceWorker: container });
        renderHook(() => {
            useNotificationOpen(onOpen);
        });

        act(() => {
            send({ type: 'openBot', botId: 'bot-2', messageId: 'message-7' });
        });

        expect(container.startMessages)
            .toHaveBeenCalled();
        expect(onOpen)
            .toHaveBeenCalledWith({ botId: 'bot-2', messageId: 'message-7' });
    });

    it('ignores messages that are not an open request', () => {
        const { container, send } = createServiceWorkerContainer();
        const onOpen = vi.fn();

        vi.stubGlobal('navigator', { serviceWorker: container });
        renderHook(() => {
            useNotificationOpen(onOpen);
        });

        act(() => {
            send({ type: 'other', botId: 'bot-2' });
            send('text');
            send(null);
            send({ type: 'openBot' });
        });

        expect(onOpen)
            .not.toHaveBeenCalled();
    });

    it('calls the newest callback and stops listening when the app closes', () => {
        const { container, send } = createServiceWorkerContainer();
        const first = vi.fn();
        const second = vi.fn();

        vi.stubGlobal('navigator', { serviceWorker: container });

        const rendered = renderHook(({ onOpen }) => {
            useNotificationOpen(onOpen);
        }, { initialProps: { onOpen: first } });

        rendered.rerender({ onOpen: second });
        act(() => {
            send({ type: 'openBot', botId: 'bot-2' });
        });

        expect(first)
            .not.toHaveBeenCalled();
        expect(second)
            .toHaveBeenCalledWith({ botId: 'bot-2', messageId: undefined });

        rendered.unmount();
        send({ type: 'openBot', botId: 'bot-3' });

        expect(second)
            .toHaveBeenCalledTimes(1);
    });

    it('does nothing in a browser without service workers', () => {
        const onOpen = vi.fn();

        vi.stubGlobal('navigator', {});

        expect(() => renderHook(() => {
            useNotificationOpen(onOpen);
        }))
            .not.toThrow();
    });
});
