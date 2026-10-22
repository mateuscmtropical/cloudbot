import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { WhatsAppStore } from './WhatsAppStore.ts';

const START_TIME = Date.UTC(2026, 9, 22, 10, 0);

describe('WhatsAppStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let store: WhatsAppStore;
    let currentTime: number;
    let anaId: string;
    let benId: string;

    beforeEach(async () => {
        currentTime = START_TIME;
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        store = new WhatsAppStore(opened.db, { now: () => currentTime });
        anaId = (await botStore.create({ name: 'Ana', title: 'Assistant', description: '' })).id;
        benId = (await botStore.create({ name: 'Ben', title: 'Assistant', description: '' })).id;
    });

    afterEach(() => {
        opened.close();
    });

    it('links a number to a bot and finds it from either side', async () => {
        const linked = await store.link(anaId, '123456789');

        expect(linked.status)
            .toBe('linked');
        expect(linked.status === 'linked' ? linked.isNew : undefined)
            .toBe(true);
        await expect(store.findByPhoneNumberId('123456789'))
            .resolves.toMatchObject({ phoneNumberId: '123456789', botId: anaId, createdAt: START_TIME });
        await expect(store.findByBotId(anaId))
            .resolves.toMatchObject({ phoneNumberId: '123456789' });
        await expect(store.list())
            .resolves.toHaveLength(1);
    });

    it('keeps the first link when the same pair is linked again', async () => {
        const first = await store.link(anaId, '123456789');
        const second = await store.link(anaId, '123456789');

        expect(first.status === 'linked' ? first.isNew : undefined)
            .toBe(true);
        expect(second.status)
            .toBe('linked');
        expect(second.status === 'linked' ? second.isNew : undefined)
            .toBe(false);
    });

    it('refuses a number that belongs to another bot', async () => {
        await store.link(anaId, '123456789');

        await expect(store.link(benId, '123456789'))
            .resolves.toEqual({ status: 'phone-taken' });
        await expect(store.findByBotId(benId))
            .resolves.toBeUndefined();
    });

    it('refuses a second number for a bot that already has one', async () => {
        await store.link(anaId, '123456789');

        await expect(store.link(anaId, '987654321'))
            .resolves.toEqual({ status: 'bot-linked', phoneNumberId: '123456789' });
        await expect(store.findByPhoneNumberId('987654321'))
            .resolves.toBeUndefined();
    });

    it('unlinks only the bot it is given', async () => {
        await store.link(anaId, '123456789');

        await expect(store.unlink(benId))
            .resolves.toBe(false);
        await expect(store.unlink(anaId))
            .resolves.toBe(true);
        await expect(store.findByPhoneNumberId('123456789'))
            .resolves.toBeUndefined();
    });

    it('claims a message id once and gives it back on release', async () => {
        await expect(store.claimMessage('wamid.one', anaId))
            .resolves.toBe(true);
        await expect(store.claimMessage('wamid.one', anaId))
            .resolves.toBe(false);

        await store.releaseMessage('wamid.one');

        await expect(store.claimMessage('wamid.one', anaId))
            .resolves.toBe(true);
    });

    it('removes only the message ids older than the cutoff', async () => {
        currentTime = START_TIME;

        await store.claimMessage('wamid.old', anaId);
        currentTime = START_TIME + 1000;
        await store.claimMessage('wamid.new', anaId);

        await expect(store.removeOldMessages(START_TIME + 1000))
            .resolves.toBe(1);
        await expect(store.claimMessage('wamid.old', anaId))
            .resolves.toBe(true);
        await expect(store.claimMessage('wamid.new', anaId))
            .resolves.toBe(false);
    });

    it('drops the links and the message ids when the bot is deleted', async () => {
        await store.link(anaId, '123456789');
        await store.claimMessage('wamid.one', anaId);

        await botStore.delete(anaId);

        await expect(store.list())
            .resolves.toEqual([]);
        await expect(store.claimMessage('wamid.one', benId))
            .resolves.toBe(true);
    });
});
