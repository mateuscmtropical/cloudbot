import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { RuleStore } from './RuleStore.ts';

describe('RuleStore', () => {
    let opened: OpenedDatabase;
    let currentTime: number;
    let botStore: BotStore;
    let store: RuleStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        currentTime = 1000;
        botStore = new BotStore(opened.db);
        store = new RuleStore(opened.db, { now: () => currentTime });
    });

    afterEach(() => {
        opened.close();
    });

    it('lists the rules of a bot oldest first', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.add(bot.id, { kind: 'allow', sentence: 'Read my calendar.', blockedTools: [] });
        currentTime = 2000;
        await store.add(bot.id, { kind: 'block', sentence: 'No shell.', blockedTools: ['Bash'] });

        const rules = await store.listForBot(bot.id);

        expect(rules.map(rule => rule.sentence))
            .toEqual(['Read my calendar.', 'No shell.']);
        expect(rules[1]?.blockedTools)
            .toEqual(['Bash']);
    });

    it('keeps the rules of one bot apart from another', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await store.add(ana.id, { kind: 'block', sentence: 'No email.', blockedTools: [] });

        expect(await store.listForBot(ben.id))
            .toEqual([]);
    });

    it('removes a rule only for the bot that owns it', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });
        const rule = await store.add(ana.id, { kind: 'block', sentence: 'No email.', blockedTools: [] });

        expect(await store.remove(ben.id, rule.id))
            .toBe(false);
        expect(await store.listForBot(ana.id))
            .toHaveLength(1);
        expect(await store.remove(ana.id, rule.id))
            .toBe(true);
        expect(await store.listForBot(ana.id))
            .toEqual([]);
    });
});
