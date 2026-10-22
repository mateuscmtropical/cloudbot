import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { WhatsAppStore } from '../store/WhatsAppStore.ts';

import { APP_SECRET_PURPOSE, APP_SECRET_REPLACEMENT_PURPOSE, OWNER_NUMBER_PURPOSE, VERIFY_TOKEN_PURPOSE, WhatsAppSetup, buildWhatsAppCallbackUrl } from './WhatsAppSetup.ts';
import type { WhatsAppSecretRequest } from './WhatsAppSetup.ts';
import {
    WHATSAPP_API_SITE,
    WHATSAPP_APP_SECRET_NAME,
    WHATSAPP_OWNER_NUMBER_NAME,
    WHATSAPP_VERIFY_TOKEN_NAME,
} from './whatsappSecrets.ts';
import type { WhatsAppSecretReader } from './whatsappSecrets.ts';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const BASE_URL = 'https://bot.example.test';
const PHONE_NUMBER_ID = '109876543210987';

interface SecretRequest {
    botId: string;
    name: string;
    purpose: string;
    site: string;
}

class FakeSecrets implements WhatsAppSecretReader {
    private readonly values = new Map<string, string>();
    readonly removed: string[] = [];

    read(botId: string, name: string): { value: string } | undefined {
        const value = this.values.get(`${botId}:${name}`);

        return value === undefined ? undefined : { value };
    }

    remove(botId: string, name: string): void {
        this.removed.push(name);
        this.values.delete(`${botId}:${name}`);
    }

    save(botId: string, name: string, value: string): void {
        this.values.set(`${botId}:${name}`, value);
    }
}

describe('WhatsAppSetup', () => {
    let opened: OpenedDatabase;
    let store: WhatsAppStore;
    let secrets: FakeSecrets;
    let requests: SecretRequest[];
    let setup: WhatsAppSetup;
    let anaId: string;
    let benId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        store = new WhatsAppStore(opened.db);
        secrets = new FakeSecrets();
        requests = [];

        const botStore = new BotStore(opened.db);

        anaId = (await botStore.create({ name: 'Ana', title: 'Assistant', description: '' })).id;
        benId = (await botStore.create({ name: 'Ben', title: 'Assistant', description: '' })).id;

        const requestSecret: WhatsAppSecretRequest = (botId, name, purpose, site) => {
            requests.push({ botId, name, purpose, site });

            return Promise.resolve({ site });
        };

        setup = new WhatsAppSetup({ store, secrets, requestSecret, publicBaseUrl: `${BASE_URL}/` });
    });

    afterEach(() => {
        opened.close();
    });

    function saveAll(): void {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);
        secrets.save(anaId, WHATSAPP_VERIFY_TOKEN_NAME, 'my-verify-token');
        secrets.save(anaId, WHATSAPP_OWNER_NUMBER_NAME, '+1 (555) 123-4567');
    }

    it('asks for the app secret first, through the secure form and the Meta site', async () => {
        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({ status: 'form', secretName: WHATSAPP_APP_SECRET_NAME, isReplacement: false });
        expect(requests)
            .toEqual([{ botId: anaId, name: WHATSAPP_APP_SECRET_NAME, purpose: APP_SECRET_PURPOSE, site: WHATSAPP_API_SITE }]);
        await expect(store.findByBotId(anaId))
            .resolves.toBeUndefined();
    });

    it('asks for the verify token next', async () => {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({ status: 'form', secretName: WHATSAPP_VERIFY_TOKEN_NAME, isReplacement: false });
        expect(requests[0]?.purpose)
            .toBe(VERIFY_TOKEN_PURPOSE);
    });

    it('asks for the owner number last', async () => {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);
        secrets.save(anaId, WHATSAPP_VERIFY_TOKEN_NAME, 'my-verify-token');

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({ status: 'form', secretName: WHATSAPP_OWNER_NUMBER_NAME, isReplacement: false });
        expect(requests[0]?.purpose)
            .toBe(OWNER_NUMBER_PURPOSE);
    });

    it('asks for the app secret again when the saved value is not a Meta app secret', async () => {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, 'not-a-secret');

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({ status: 'form', secretName: WHATSAPP_APP_SECRET_NAME, isReplacement: true });
        expect(requests[0]?.purpose)
            .toBe(APP_SECRET_REPLACEMENT_PURPOSE);
    });

    it('asks for the owner number again when it is not a valid number', async () => {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);
        secrets.save(anaId, WHATSAPP_VERIFY_TOKEN_NAME, 'my-verify-token');
        secrets.save(anaId, WHATSAPP_OWNER_NUMBER_NAME, 'not a number');

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({ status: 'form', secretName: WHATSAPP_OWNER_NUMBER_NAME, isReplacement: true });
        await expect(store.findByBotId(anaId))
            .resolves.toBeUndefined();
    });

    it('links the number when all three secrets are valid, and returns the callback URL', async () => {
        saveAll();

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toEqual({
                status: 'linked',
                phoneNumberId: PHONE_NUMBER_ID,
                callbackUrl: `${BASE_URL}/whatsapp`,
                isAlreadyLinked: false,
            });
        await expect(store.findByBotId(anaId))
            .resolves.toMatchObject({ phoneNumberId: PHONE_NUMBER_ID });
        expect(requests)
            .toEqual([]);
    });

    it('links the same pair again without asking for a new form', async () => {
        saveAll();
        await setup.connect(anaId, PHONE_NUMBER_ID);

        const outcome = await setup.connect(anaId, PHONE_NUMBER_ID);

        expect(outcome)
            .toMatchObject({ status: 'linked', isAlreadyLinked: true });
        expect(requests)
            .toEqual([]);
    });

    it('refuses a phone number id that is not numeric', async () => {
        const outcome = await setup.connect(anaId, '+1 (555) 123-4567');

        expect(outcome)
            .toEqual({ status: 'invalid-phone-number-id' });
        expect(requests)
            .toEqual([]);
    });

    it('refuses a number that belongs to another bot', async () => {
        saveAll();
        await store.link(benId, PHONE_NUMBER_ID);

        await expect(setup.connect(anaId, PHONE_NUMBER_ID))
            .resolves.toEqual({ status: 'phone-taken' });
    });

    it('refuses a second number for a bot that already has one', async () => {
        saveAll();
        await store.link(anaId, '555555555');

        await expect(setup.connect(anaId, PHONE_NUMBER_ID))
            .resolves.toEqual({ status: 'bot-linked', phoneNumberId: '555555555' });
    });

    it('disconnects the number and removes all three secrets', async () => {
        saveAll();
        await setup.connect(anaId, PHONE_NUMBER_ID);

        await expect(setup.disconnect(anaId))
            .resolves.toBe(true);
        await expect(store.findByBotId(anaId))
            .resolves.toBeUndefined();
        expect(secrets.removed)
            .toEqual([WHATSAPP_APP_SECRET_NAME, WHATSAPP_VERIFY_TOKEN_NAME, WHATSAPP_OWNER_NUMBER_NAME]);
        expect(secrets.read(anaId, WHATSAPP_APP_SECRET_NAME))
            .toBeUndefined();
    });

    it('still removes the secrets when the bot had no connection', async () => {
        secrets.save(anaId, WHATSAPP_APP_SECRET_NAME, APP_SECRET);

        await expect(setup.disconnect(anaId))
            .resolves.toBe(false);
        expect(secrets.read(anaId, WHATSAPP_APP_SECRET_NAME))
            .toBeUndefined();
    });

    it('builds the callback URL without a double slash', () => {
        expect(buildWhatsAppCallbackUrl('https://bot.example.test/'))
            .toBe('https://bot.example.test/whatsapp');
        expect(buildWhatsAppCallbackUrl('https://bot.example.test/base'))
            .toBe('https://bot.example.test/base/whatsapp');
    });
});
