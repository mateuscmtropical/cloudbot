import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BotStore } from './BotStore.ts';
import { ensureDefaultBot } from './ensureDefaultBot.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('ensureDefaultBot', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    it('creates the CloudBot default bot when the store has no bots', async () => {
        await ensureDefaultBot(botStore);

        const bots = await botStore.list();

        expect(bots)
            .toEqual([expect.objectContaining({ name: 'CloudBot', title: 'Your coworker' })]);
    });

    it('creates nothing when a bot already exists', async () => {
        const existingBot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        await ensureDefaultBot(botStore);

        const bots = await botStore.list();

        expect(bots.map(bot => bot.id))
            .toEqual([existingBot.id]);
    });

    it('does not add a second default bot on the next start', async () => {
        await ensureDefaultBot(botStore);
        await ensureDefaultBot(botStore);

        const bots = await botStore.list();

        expect(bots)
            .toHaveLength(1);
    });
});
