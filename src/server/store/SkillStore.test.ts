import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';
import { SkillStore } from './SkillStore.ts';

describe('SkillStore', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let clock: number;
    let store: SkillStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        clock = 1000;
        store = new SkillStore(opened.db, { now: () => clock });
    });

    afterEach(() => {
        opened.close();
    });

    it('lists the skills of a bot by name, and keeps them apart from other bots', async () => {
        const ana = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: 'Assistant', description: '' });

        await store.save(ana.id, { name: 'weekly-report', description: 'Writes the report.', text: 'Step 1.' });
        await store.save(ana.id, { name: 'invoices', description: 'Files invoices.', text: 'Step A.' });
        await store.save(ben.id, { name: 'other', description: 'Other.', text: 'X.' });

        const names = (await store.list(ana.id)).map(skill => skill.name);

        expect(names)
            .toEqual(['invoices', 'weekly-report']);
        expect(await store.get(ana.id, 'other'))
            .toBeUndefined();
    });

    it('replaces a skill with the same name and keeps its first date', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, { name: 'weekly-report', description: 'Old.', text: 'Old steps.' });
        clock = 2000;
        await store.save(bot.id, { name: 'weekly-report', description: 'New.', text: 'New steps.' });

        expect(await store.list(bot.id))
            .toMatchObject([{ name: 'weekly-report', description: 'New.', text: 'New steps.', createdAt: 1000, updatedAt: 2000 }]);
    });

    it('removes a skill by name, says when there is none, and drops the skills with their bot', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await store.save(bot.id, { name: 'a', description: 'A.', text: 'A.' });
        await store.save(bot.id, { name: 'b', description: 'B.', text: 'B.' });

        expect(await store.remove(bot.id, 'a'))
            .toBe(true);
        expect(await store.remove(bot.id, 'a'))
            .toBe(false);
        await botStore.delete(bot.id);
        expect(await store.list(bot.id))
            .toEqual([]);
    });
});
