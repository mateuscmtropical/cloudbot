import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { PushSubscriptionStore } from '../store/PushSubscriptionStore.ts';
import type { PushNotice } from '../../shared/pushTypes.ts';
import type { PushRequest } from './createPushSender.ts';
import { NOTICE_LINES, PushNotifier, buildPushNotice } from './PushNotifier.ts';
import { generateVapidKeyPair } from './webPushCrypto.ts';

interface FakeBrowser {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    privateKey: Buffer;
    publicKey: Buffer;
    authSecret: Buffer;
}

function createFakeBrowser(endpoint: string): FakeBrowser {
    const ecdh = createECDH('prime256v1');

    ecdh.generateKeys();

    const authSecret = Buffer.alloc(16, 3);

    return {
        endpoint,
        keys: { p256dh: ecdh.getPublicKey()
            .toString('base64url'), auth: authSecret.toString('base64url') },
        privateKey: ecdh.getPrivateKey(),
        publicKey: ecdh.getPublicKey(),
        authSecret,
    };
}

// Reads the body the way a browser does, to see what the push service carries.
function readAsBrowser(browser: FakeBrowser, body: Buffer): PushNotice {
    const salt = body.subarray(0, 16);
    const keyIdLength = body.readUInt8(20);
    const senderPublicKey = body.subarray(21, 21 + keyIdLength);
    const encrypted = body.subarray(21 + keyIdLength);
    const ecdh = createECDH('prime256v1');

    ecdh.setPrivateKey(browser.privateKey);

    const sharedSecret = ecdh.computeSecret(senderPublicKey);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), browser.publicKey, senderPublicKey]);
    const inputKey = Buffer.from(hkdfSync('sha256', sharedSecret, browser.authSecret, keyInfo, 32));
    const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);

    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));

    const record = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]);
    // The padding is zero bytes after the delimiter 2.
    const delimiterIndex = record.findLastIndex(byte => byte !== 0);
    const text = record.subarray(0, delimiterIndex)
        .toString('utf8');

    return JSON.parse(text) as PushNotice;
}

describe('PushNotifier', () => {
    let opened: OpenedDatabase;
    let store: PushSubscriptionStore;
    const sent: PushRequest[] = [];
    let statusFor: (endpoint: string) => number;

    function createNotifier(now: () => number = () => 1_000_000): PushNotifier {
        return new PushNotifier({
            store,
            keys: generateVapidKeyPair(),
            subject: 'https://example.com',
            now,
            send: (request) => {
                sent.push(request);

                return Promise.resolve(statusFor(request.endpoint));
            },
        });
    }

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new PushSubscriptionStore(opened.db);
        sent.length = 0;
        statusFor = () => 201;
    });

    afterEach(() => {
        opened.close();
        vi.restoreAllMocks();
    });

    it('sends nothing when no browser subscribed', async () => {
        const notifier = createNotifier();

        await notifier.notify({ kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: 'message-1' });

        expect(sent)
            .toHaveLength(0);
    });

    it('sends the bot name and a neutral line to every subscribed browser, encrypted for each', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');
        const laptop = createFakeBrowser('https://updates.push.services.mozilla.com/wpush/v2/laptop');

        await store.save({ endpoint: phone.endpoint, ...phone.keys });
        await store.save({ endpoint: laptop.endpoint, ...laptop.keys });

        const notifier = createNotifier();

        await notifier.notify({ kind: 'approval', botId: 'bot-1', botName: 'Ana', messageId: 'message-9' });

        expect(sent)
            .toHaveLength(2);

        const phoneRequest = sent.find(request => request.endpoint === phone.endpoint);
        const laptopRequest = sent.find(request => request.endpoint === laptop.endpoint);

        expect(readAsBrowser(phone, phoneRequest?.body ?? Buffer.alloc(0)))
            .toEqual({ title: 'Ana', body: NOTICE_LINES.approval, kind: 'approval', botId: 'bot-1', messageId: 'message-9' });
        expect(readAsBrowser(laptop, laptopRequest?.body ?? Buffer.alloc(0)))
            .toEqual({ title: 'Ana', body: NOTICE_LINES.approval, kind: 'approval', botId: 'bot-1', messageId: 'message-9' });
        // One browser cannot read the push meant for the other.
        expect(() => readAsBrowser(laptop, phoneRequest?.body ?? Buffer.alloc(0)))
            .toThrow();
    });

    it('signs for the push service origin and asks it to keep the push for an hour', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');

        await store.save({ endpoint: phone.endpoint, ...phone.keys });

        const notifier = createNotifier();

        await notifier.notify({ kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined });

        const headers = sent[0]?.headers ?? {};
        const claimsPart = (headers.Authorization ?? '').split(' ')[1]?.split('.')[1] ?? '';
        const claims = JSON.parse(Buffer.from(claimsPart, 'base64url')
            .toString('utf8')) as Record<string, unknown>;

        expect(claims.aud)
            .toBe('https://fcm.googleapis.com');
        expect(claims.sub)
            .toBe('https://example.com');
        expect(claims.exp)
            .toBe(1_000 + 12 * 60 * 60);
        expect(headers.TTL)
            .toBe('3600');
        expect(headers['Content-Encoding'])
            .toBe('aes128gcm');
        expect(headers['Content-Length'])
            .toBe(String(sent[0]?.body.length));
    });

    it('leaves the message id out of the payload when there is none', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');

        await store.save({ endpoint: phone.endpoint, ...phone.keys });

        const notifier = createNotifier();

        await notifier.notify({ kind: 'screen', botId: 'bot-1', botName: 'Ana', messageId: undefined });

        const notice = readAsBrowser(phone, sent[0]?.body ?? Buffer.alloc(0));

        expect(notice)
            .toEqual({ title: 'Ana', body: NOTICE_LINES.screen, kind: 'screen', botId: 'bot-1' });
    });

    it.each([404, 410])('removes a subscription when the push service answers %i', async (status) => {
        const gone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/gone');
        const alive = createFakeBrowser('https://fcm.googleapis.com/fcm/send/alive');

        await store.save({ endpoint: gone.endpoint, ...gone.keys });
        await store.save({ endpoint: alive.endpoint, ...alive.keys });
        statusFor = endpoint => (endpoint === gone.endpoint ? status : 201);

        const notifier = createNotifier();

        await notifier.notify({ kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined });

        const remaining = await store.list();

        expect(remaining.map(record => record.endpoint))
            .toEqual([alive.endpoint]);
    });

    it('keeps a subscription after a server error and logs only the status', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');
        const errorLog = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        await store.save({ endpoint: phone.endpoint, ...phone.keys });
        statusFor = () => 503;

        const notifier = createNotifier();

        await notifier.notify({ kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined });

        await expect(store.list())
            .resolves.toHaveLength(1);
        expect(errorLog)
            .toHaveBeenCalledWith('A push service refused a notification with status 503.');
    });

    it('keeps going when one send throws, and never logs the endpoint', async () => {
        const first = createFakeBrowser('https://fcm.googleapis.com/fcm/send/first');
        const second = createFakeBrowser('https://fcm.googleapis.com/fcm/send/second');
        const errorLog = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);

        await store.save({ endpoint: first.endpoint, ...first.keys });
        await store.save({ endpoint: second.endpoint, ...second.keys });

        const notifier = new PushNotifier({
            store,
            keys: generateVapidKeyPair(),
            subject: 'https://example.com',
            send: (request) => {
                sent.push(request);

                return request.endpoint === first.endpoint ? Promise.reject(new Error(`cannot reach ${request.endpoint}`)) : Promise.resolve(201);
            },
        });

        await notifier.notify({ kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined });

        expect(sent)
            .toHaveLength(2);
        expect(errorLog)
            .toHaveBeenCalledWith('A push notification could not be sent.');
        expect(JSON.stringify(errorLog.mock.calls))
            .not.toContain('fcm.googleapis.com');
    });

    it('sends every push with a body of the same size, whatever the notice says', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');

        await store.save({ endpoint: phone.endpoint, ...phone.keys });

        const notifier = createNotifier();
        const messageId = 'a2d6a3a0-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

        await notifier.notify({ kind: 'approval', botId: 'bot-1', botName: 'A', messageId: undefined });
        await notifier.notify({ kind: 'screen', botId: 'bot-2', botName: 'A very long name for a bot, with many words in it', messageId });
        await notifier.notify({ kind: 'approval', botId: 'bot-3', botName: '\u{1F600}'.repeat(60), messageId });

        const sizes = sent.map(request => request.body.length);

        expect(sizes)
            .toEqual([614, 614, 614]);
    });

    it('cuts a long bot name in the title and keeps the rest', async () => {
        const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');

        await store.save({ endpoint: phone.endpoint, ...phone.keys });

        const notifier = createNotifier();

        await notifier.notify({ kind: 'approval', botId: 'bot-1', botName: '\u{1F600}'.repeat(60), messageId: undefined });

        const notice = readAsBrowser(phone, sent[0]?.body ?? Buffer.alloc(0));

        expect(Array.from(notice.title))
            .toHaveLength(40);
        expect(notice.body)
            .toBe(NOTICE_LINES.approval);
    });

    describe('done pushes', () => {
        const DONE = { kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined } as const;

        async function subscribeOnePhone(): Promise<void> {
            const phone = createFakeBrowser('https://fcm.googleapis.com/fcm/send/phone');

            await store.save({ endpoint: phone.endpoint, ...phone.keys });
        }

        it('sends at most one for a bot in a minute and sends again after it', async () => {
            await subscribeOnePhone();

            let currentTime = 1_000_000;
            const notifier = createNotifier(() => currentTime);

            await notifier.notify(DONE);
            currentTime += 59_000;
            await notifier.notify(DONE);

            expect(sent)
                .toHaveLength(1);

            currentTime += 1_000;
            await notifier.notify(DONE);

            expect(sent)
                .toHaveLength(2);
        });

        it('counts each bot on its own', async () => {
            await subscribeOnePhone();

            const notifier = createNotifier();

            await notifier.notify(DONE);
            await notifier.notify({ ...DONE, botId: 'bot-2' });

            expect(sent)
                .toHaveLength(2);
        });

        it('never holds back an approval or a screen hand-off', async () => {
            await subscribeOnePhone();

            const notifier = createNotifier();

            await notifier.notify(DONE);
            await notifier.notify({ ...DONE, kind: 'approval' });
            await notifier.notify({ ...DONE, kind: 'approval' });
            await notifier.notify({ ...DONE, kind: 'screen' });

            expect(sent)
                .toHaveLength(4);
        });
    });

    it('exposes the public key that matches its signing key', () => {
        const keys = generateVapidKeyPair();
        const notifier = new PushNotifier({ store, keys, subject: 'https://example.com', send: () => Promise.resolve(201) });

        expect(notifier.publicKey)
            .toBe(keys.publicKey);
    });
});

describe('buildPushNotice', () => {
    const DONE = { kind: 'done', botId: 'bot-1', botName: 'Ana', messageId: undefined } as const;

    it('shows the line of the turn on one line', () => {
        const notice = buildPushNotice({ ...DONE, body: 'Sent the\n weekly report ' });

        expect(notice.body)
            .toBe('Sent the weekly report');
    });

    it('falls back to the plain line without a line of its own', () => {
        const withoutLine = buildPushNotice(DONE);
        const blankLine = buildPushNotice({ ...DONE, body: '  ' });

        expect(withoutLine.body)
            .toBe(NOTICE_LINES.done);
        expect(blankLine.body)
            .toBe(NOTICE_LINES.done);
    });
});
