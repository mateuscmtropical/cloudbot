import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import type { MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { Bot } from '../store/types.ts';
import { SET_MASCOT_TOOL_FULL_NAME, SET_MASCOT_TOOL_SHAPE, createSetMascotTool } from './createProfileToolServer.ts';

// The SDK types optional fields as present with undefined, so the test passes both keys.
function buildArguments(color: MascotColorName | undefined, shape: MascotShape | undefined): { color: MascotColorName | undefined; shape: MascotShape | undefined } {
    return { color, shape };
}

describe('createSetMascotTool', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let bot: Bot;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });
    });

    afterEach(() => {
        opened.close();
    });

    it('is named profile_set_mascot and the model calls it as mcp__cloudbot__profile_set_mascot', () => {
        const tool = createSetMascotTool(botStore, bot.id);

        expect(tool.name)
            .toBe('profile_set_mascot');
        expect(SET_MASCOT_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__profile_set_mascot');
    });

    it('saves the color and the shape the model passes', async () => {
        const tool = createSetMascotTool(botStore, bot.id);

        const result = await tool.handler(buildArguments('mint', 'wide'), undefined);

        expect(result.isError)
            .toBeUndefined();
        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ mascotColor: 'mint', mascotShape: 'wide' });
    });

    it('changes only the field the model passes', async () => {
        const tool = createSetMascotTool(botStore, bot.id);
        const before = await botStore.getById(bot.id);

        await tool.handler(buildArguments('pink', undefined), undefined);

        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ mascotColor: 'pink', mascotShape: before?.mascotShape });
    });

    it('refuses a call with no color and no shape, and changes nothing', async () => {
        const tool = createSetMascotTool(botStore, bot.id);
        const before = await botStore.getById(bot.id);

        const result = await tool.handler(buildArguments(undefined, undefined), undefined);

        expect(result.isError)
            .toBe(true);
        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ mascotColor: before?.mascotColor, mascotShape: before?.mascotShape });
    });

    it('rejects a color or shape outside the palette', () => {
        const schema = z.object(SET_MASCOT_TOOL_SHAPE);

        expect(schema.safeParse({ color: 'brown' }).success)
            .toBe(false);
        expect(schema.safeParse({ shape: 'square' }).success)
            .toBe(false);
        expect(schema.safeParse({ color: 'blue', shape: 'tall' }).success)
            .toBe(true);
    });
});
