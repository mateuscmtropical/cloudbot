import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import { EmailAccountStore } from './EmailAccountStore.ts';
import type { EmailAccountSettings } from './EmailAccountStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

const SETTINGS: EmailAccountSettings = {
    address: 'bot@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: 'bot@example.com',
};

describe('EmailAccountStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let store: EmailAccountStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        store = new EmailAccountStore(opened.db, { now: () => Date.UTC(2026, 9, 22, 10, 0) });
    });

    afterEach(() => {
        opened.close();
    });

    it('saves a new account without a cursor and lists it', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const saved = await store.save(bot.id, SETTINGS);

        expect(saved.isChanged)
            .toBe(true);
        expect(saved.account)
            .toMatchObject({ ...SETTINGS, botId: bot.id, uidValidity: null, lastUid: null, createdAt: Date.UTC(2026, 9, 22, 10, 0) });
        await expect(store.get(bot.id))
            .resolves.toEqual(saved.account);
        await expect(store.list())
            .resolves.toEqual([saved.account]);
    });

    it('keeps the cursor when the settings are saved again unchanged', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const saved = await store.save(bot.id, SETTINGS);

        await store.setBaseline(bot.id, { uidValidity: null, lastUid: null }, 'v1', 10);

        const savedAgain = await store.save(bot.id, SETTINGS);

        expect(savedAgain.isChanged)
            .toBe(false);
        expect(savedAgain.account.createdAt)
            .toBe(saved.account.createdAt);
        expect(savedAgain.account.uidValidity)
            .toBe('v1');
        expect(savedAgain.account.lastUid)
            .toBe(10);
    });

    it('resets the cursor and the deliveries when a setting changes', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, SETTINGS);
        await store.setBaseline(bot.id, { uidValidity: null, lastUid: null }, 'v1', 10);
        await store.claimDelivery(bot.id, 'v1', 11);

        const changed = await store.save(bot.id, { ...SETTINGS, address: 'other@example.com' });

        expect(changed.isChanged)
            .toBe(true);
        expect(changed.account.uidValidity)
            .toBeNull();
        expect(changed.account.lastUid)
            .toBeNull();
        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(true);
    });

    it('records a baseline only from the cursor it expected', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, SETTINGS);

        await expect(store.setBaseline(bot.id, { uidValidity: 'other', lastUid: null }, 'v1', 10))
            .resolves.toBe(false);
        await expect(store.setBaseline(bot.id, { uidValidity: null, lastUid: null }, 'v1', 10))
            .resolves.toBe(true);
        await store.claimDelivery(bot.id, 'v1', 11);
        await expect(store.setBaseline(bot.id, { uidValidity: 'v1', lastUid: 10 }, 'v2', 20))
            .resolves.toBe(true);
        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(true);
    });

    it('advances the cursor only while the mailbox is the same', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, SETTINGS);
        await store.setBaseline(bot.id, { uidValidity: null, lastUid: null }, 'v1', 10);

        await expect(store.advanceCursor(bot.id, 'v2', 20))
            .resolves.toBe(false);
        await expect(store.advanceCursor(bot.id, 'v1', 11))
            .resolves.toBe(true);
        await expect(store.get(bot.id))
            .resolves.toMatchObject({ uidValidity: 'v1', lastUid: 11 });
    });

    it('claims a mail once and gives it back on release', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, SETTINGS);

        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(true);
        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(false);
        await store.releaseDelivery(bot.id, 'v1', 11);
        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(true);
    });

    it('removes every delivery of a bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await store.save(bot.id, SETTINGS);
        await store.save(otherBot.id, SETTINGS);
        await store.claimDelivery(bot.id, 'v1', 11);
        await store.claimDelivery(otherBot.id, 'v1', 11);

        await store.clearDeliveries(bot.id);

        await expect(store.claimDelivery(bot.id, 'v1', 11))
            .resolves.toBe(true);
        await expect(store.claimDelivery(otherBot.id, 'v1', 11))
            .resolves.toBe(false);
    });
});
