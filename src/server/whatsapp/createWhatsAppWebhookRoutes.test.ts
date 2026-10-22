import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WhatsAppStore } from '../store/WhatsAppStore.ts';

import { MAX_BODY_BYTES, UNSUPPORTED_MESSAGE_NOTE, createWhatsAppWebhookRoutes } from './createWhatsAppWebhookRoutes.ts';
import {
    WHATSAPP_APP_SECRET_NAME,
    WHATSAPP_OWNER_NUMBER_NAME,
    WHATSAPP_VERIFY_TOKEN_NAME,
} from './whatsappSecrets.ts';
import type { WhatsAppSecretReader } from './whatsappSecrets.ts';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210';
const VERIFY_TOKEN = 'my-verify-token';
const OWNER_NUMBER = '15551234567';
const PHONE_NUMBER_ID = '109876543210987';
const OTHER_PHONE_NUMBER_ID = '999888777666555';
const UNKNOWN_PHONE_NUMBER_ID = '111222333444555';

interface PayloadMessage {
    id: string;
    from?: string;
    type: string;
    text?: { body: string };
}

class FakeSecrets implements WhatsAppSecretReader {
    private readonly values = new Map<string, string>();

    read(botId: string, name: string): { value: string } | undefined {
        const value = this.values.get(`${botId}:${name}`);

        return value === undefined ? undefined : { value };
    }

    save(botId: string, name: string, value: string): void {
        this.values.set(`${botId}:${name}`, value);
    }
}

function buildBody(messages: PayloadMessage[], phoneNumberId = PHONE_NUMBER_ID): string {
    return JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
            id: 'business-account',
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
                    messages,
                },
            }],
        }],
    });
}

function buildStatusBody(phoneNumberId = PHONE_NUMBER_ID): string {
    return JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { phone_number_id: phoneNumberId },
                    statuses: [{ id: 'wamid.status', status: 'delivered' }],
                },
            }],
        }],
    });
}

function sign(body: string, secret = APP_SECRET): string {
    const digest = createHmac('sha256', secret)
        .update(body)
        .digest('hex');

    return `sha256=${digest}`;
}

describe('createWhatsAppWebhookRoutes', () => {
    let opened: OpenedDatabase;
    let store: WhatsAppStore;
    let secrets: FakeSecrets;
    let botId: string;
    let otherBotId: string;
    let sentTexts: string[];
    let systemNotes: string[];
    let isReady: boolean;
    let shouldFail: boolean;
    let app: ReturnType<typeof createWhatsAppWebhookRoutes>;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new WhatsAppStore(opened.db);
        secrets = new FakeSecrets();
        sentTexts = [];
        systemNotes = [];
        isReady = true;
        shouldFail = false;

        const botStore = new BotStore(opened.db);

        botId = (await botStore.create({ name: 'Ana', title: 'Assistant', description: '' })).id;
        otherBotId = (await botStore.create({ name: 'Ben', title: 'Assistant', description: '' })).id;

        secrets.save(botId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);
        secrets.save(botId, WHATSAPP_VERIFY_TOKEN_NAME, VERIFY_TOKEN);
        secrets.save(botId, WHATSAPP_OWNER_NUMBER_NAME, '+1 (555) 123-4567');
        await store.link(botId, PHONE_NUMBER_ID);

        app = createWhatsAppWebhookRoutes({
            store,
            secrets,
            isReady: () => isReady,
            sendMessage: (sentBotId, text) => {
                if (shouldFail) {
                    return Promise.reject(new Error('failed'));
                }

                sentTexts.push(`${sentBotId}:${text}`);

                return Promise.resolve({});
            },
            postSystemNote: (notedBotId, text) => {
                systemNotes.push(`${notedBotId}:${text}`);

                return Promise.resolve({});
            },
        });
    });

    afterEach(() => {
        opened.close();
    });

    function handshake(query: string): Response | Promise<Response> {
        return app.request(`/whatsapp?${query}`);
    }

    function post(body: string, signature = sign(body)): Response | Promise<Response> {
        return app.request('/whatsapp', {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
        });
    }

    it('answers the Meta verification handshake with the challenge', async () => {
        const response = await handshake(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=challenge-text`);

        expect(response.status)
            .toBe(200);
        await expect(response.text())
            .resolves.toBe('challenge-text');
    });

    it('refuses a wrong verify token, another mode or a missing challenge', async () => {
        expect((await handshake('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x')).status)
            .toBe(403);
        expect((await handshake(`hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=x`)).status)
            .toBe(403);
        expect((await handshake(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`)).status)
            .toBe(403);
    });

    it('accepts the verify token of any connected bot', async () => {
        secrets.save(otherBotId, WHATSAPP_APP_SECRET_NAME, OTHER_SECRET);
        secrets.save(otherBotId, WHATSAPP_VERIFY_TOKEN_NAME, 'other-token');
        secrets.save(otherBotId, WHATSAPP_OWNER_NUMBER_NAME, '15550001111');
        await store.link(otherBotId, OTHER_PHONE_NUMBER_ID);

        const response = await handshake('hub.mode=subscribe&hub.verify_token=other-token&hub.challenge=ok');

        expect(response.status)
            .toBe(200);
        await expect(response.text())
            .resolves.toBe('ok');
    });

    it('sends a valid owner text message to the chat, with no WhatsApp reply', async () => {
        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Build the report' } }]);
        const response = await post(body);

        expect(response.status)
            .toBe(200);
        await expect(response.json())
            .resolves.toEqual({ status: 'received' });
        expect(sentTexts)
            .toEqual([`${botId}:Build the report`]);
        expect(systemNotes)
            .toEqual([]);
    });

    it('refuses a missing or invalid signature and does not claim the message', async () => {
        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);

        expect((await post(body, '')).status)
            .toBe(401);
        expect((await post(body, `sha256=${'0'.repeat(64)}`)).status)
            .toBe(401);
        expect(sentTexts)
            .toEqual([]);

        // The same id still works, so a refused call did not consume it.
        expect((await post(body)).status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:Hello`]);
    });

    it('refuses a body that changed after it was signed', async () => {
        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);
        const changedBody = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Changed' } }]);

        const response = await post(changedBody, sign(body));

        expect(response.status)
            .toBe(401);
        expect(sentTexts)
            .toEqual([]);
    });

    it('drops a message from another number silently and does not claim it', async () => {
        const body = buildBody([{ id: 'wamid.stranger', from: '15559999999', type: 'text', text: { body: 'Hello' } }]);

        const response = await post(body);

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([]);

        // A later message from the owner with that id is a different delivery and is handled.
        const ownerBody = buildBody([{ id: 'wamid.stranger', from: OWNER_NUMBER, type: 'text', text: { body: 'Owner' } }]);

        expect((await post(ownerBody)).status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:Owner`]);
    });

    it('handles a retried message id only once', async () => {
        const body = buildBody([{ id: 'wamid.retry', from: OWNER_NUMBER, type: 'text', text: { body: 'Once' } }]);

        expect((await post(body)).status)
            .toBe(200);
        expect((await post(body)).status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:Once`]);
    });

    it('posts a system note for a message that is not text', async () => {
        const body = buildBody([{ id: 'wamid.image', from: OWNER_NUMBER, type: 'image' }]);

        const response = await post(body);

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([]);
        expect(systemNotes)
            .toEqual([`${botId}:${UNSUPPORTED_MESSAGE_NOTE}`]);
    });

    it('answers a status callback without sending anything', async () => {
        const response = await post(buildStatusBody());

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([]);
        expect(systemNotes)
            .toEqual([]);
    });

    it('ignores an unknown phone number id after checking the signature', async () => {
        const body = buildBody([{ id: 'wamid.unknown', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }], UNKNOWN_PHONE_NUMBER_ID);

        const response = await post(body);

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([]);
    });

    it('refuses a body signed with the secret of another app', async () => {
        secrets.save(otherBotId, WHATSAPP_APP_SECRET_NAME, OTHER_SECRET);
        secrets.save(otherBotId, WHATSAPP_VERIFY_TOKEN_NAME, 'other-token');
        secrets.save(otherBotId, WHATSAPP_OWNER_NUMBER_NAME, '15550001111');
        await store.link(otherBotId, OTHER_PHONE_NUMBER_ID);

        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);
        const response = await post(body, sign(body, OTHER_SECRET));

        expect(response.status)
            .toBe(401);
        expect(sentTexts)
            .toEqual([]);
    });

    it('answers 503 before the setup is done and handles the retry once it is', async () => {
        isReady = false;

        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);

        expect((await post(body)).status)
            .toBe(503);
        expect(sentTexts)
            .toEqual([]);

        isReady = true;

        expect((await post(body)).status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:Hello`]);
    });

    it('gives the claim back when a message fails, so Meta can send it again', async () => {
        const body = buildBody([{ id: 'wamid.fail', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);

        shouldFail = true;

        expect((await post(body)).status)
            .toBe(500);
        expect(sentTexts)
            .toEqual([]);

        shouldFail = false;

        expect((await post(body)).status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:Hello`]);
    });

    it('handles several messages in the order Meta sent them', async () => {
        const body = buildBody([
            { id: 'wamid.first', from: OWNER_NUMBER, type: 'text', text: { body: 'First' } },
            { id: 'wamid.second', from: OWNER_NUMBER, type: 'text', text: { body: 'Second' } },
        ]);

        const response = await post(body);

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([`${botId}:First`, `${botId}:Second`]);
    });

    it('refuses a body larger than the limit', async () => {
        const body = 'x'.repeat(MAX_BODY_BYTES + 1);
        const response = await post(body);

        expect(response.status)
            .toBe(413);
    });

    it('checks the signature before refusing a body that is not JSON', async () => {
        const body = 'not json';
        const unsignedResponse = await post(body, '');
        const signedResponse = await post(body);

        expect(unsignedResponse.status)
            .toBe(401);
        expect(signedResponse.status)
            .toBe(400);
        expect(sentTexts)
            .toEqual([]);
    });

    it('ignores a message when the saved owner number is not valid', async () => {
        secrets.save(botId, WHATSAPP_OWNER_NUMBER_NAME, 'not a number');
        const body = buildBody([{ id: 'wamid.one', from: OWNER_NUMBER, type: 'text', text: { body: 'Hello' } }]);

        const response = await post(body);

        expect(response.status)
            .toBe(200);
        expect(sentTexts)
            .toEqual([]);
    });
});
