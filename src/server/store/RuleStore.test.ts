import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { RuleStore } from './RuleStore.ts';

describe('RuleStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let clock: number;
    let store: RuleStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        clock = 1000;
        store = new RuleStore(opened.db, { now: () => clock });
    });

    afterEach(() => {
        opened.close();
    });

    it('lists the rules of a bot in the order they were added', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.add(bot.id, { kind: 'block', text: 'Never delete files.', blockedTools: ['Bash(rm:*)'] });
        clock = 2000;
        await store.add(bot.id, { kind: 'allow', text: 'You may read my calendar.', blockedTools: [] });

        const rules = await store.list(bot.id);

        expect(rules.map(rule => [rule.kind, rule.text, rule.blockedTools]))
            .toEqual([['block', 'Never delete files.', ['Bash(rm:*)']], ['allow', 'You may read my calendar.', []]]);
    });

    it('removes a rule only for its own bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const otherBot = await botStore.create({ name: 'Bia', title: 'Assistant', description: '' });
        const rule = await store.add(bot.id, { kind: 'block', text: 'No purchases.', blockedTools: [] });

        await expect(store.remove(otherBot.id, rule.id))
            .resolves.toBe(false);
        await expect(store.remove(bot.id, rule.id))
            .resolves.toBe(true);
        await expect(store.list(bot.id))
            .resolves.toEqual([]);
    });
});
