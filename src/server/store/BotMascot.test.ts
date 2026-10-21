import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MASCOT_COLOR_NAMES, MASCOT_SHAPES } from '../../shared/mascot.ts';
import { BotStore } from './BotStore.ts';
import type { OpenedDatabase } from './openDatabase.ts';
import { openDatabase } from './openDatabase.ts';

describe('bot mascot columns', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
    });

    afterEach(() => {
        opened.close();
    });

    it('gives a new bot a color and a shape from the palette', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        expect(MASCOT_COLOR_NAMES)
            .toContain(bot.mascotColor);
        expect(MASCOT_SHAPES)
            .toContain(bot.mascotShape);
    });

    it('returns the mascot fields in the bot list', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
        const listed = await botStore.list();

        expect(listed[0])
            .toMatchObject({ id: bot.id, mascotColor: bot.mascotColor, mascotShape: bot.mascotShape });
    });

    it('changes only the mascot fields that are passed', async () => {
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: 'Helps' });

        const updated = await botStore.updateMascot(bot.id, { color: 'pink' });

        expect(updated)
            .toMatchObject({ name: 'Ana', description: 'Helps', mascotColor: 'pink', mascotShape: bot.mascotShape });
    });

    it('returns undefined for a bot that does not exist', async () => {
        await expect(botStore.updateMascot('missing', { shape: 'tall' }))
            .resolves.toBeUndefined();
    });
});
