import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import type { Bot } from '../store/types.ts';
import {
    PROFILE_SERVER_NAME,
    PROFILE_TOOL_SHAPE,
    UPDATE_PROFILE_TOOL_FULL_NAME,
    createProfileToolServer,
    createUpdateProfileTool,
} from './createProfileToolServer.ts';

const profileSchema = z.object(PROFILE_TOOL_SHAPE);

interface ProfileArguments {
    name: string | undefined;
    title: string | undefined;
    description: string | undefined;
}

// The SDK types optional fields as present with undefined, so the test passes every key.
function buildArguments(fields: Partial<ProfileArguments>): ProfileArguments {
    return {
        name: fields.name,
        title: fields.title,
        description: fields.description,
    };
}

describe('createUpdateProfileTool', () => {
    let opened: OpenedDatabase;
    let botStore: BotStore;
    let bot: Bot;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        botStore = new BotStore(opened.db);
        bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: 'Helps with mail' });
    });

    afterEach(() => {
        opened.close();
    });

    it('is named update_profile and the model calls it as mcp__cloudbot__update_profile', () => {
        const tool = createUpdateProfileTool(botStore, bot.id);

        expect(tool.name)
            .toBe('update_profile');
        expect(UPDATE_PROFILE_TOOL_FULL_NAME)
            .toBe('mcp__cloudbot__update_profile');
    });

    it('saves the new name, title and description for the bot', async () => {
        const tool = createUpdateProfileTool(botStore, bot.id);

        await tool.handler(buildArguments({ name: 'Bia', title: 'Editor', description: 'Edits text' }), undefined);

        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ name: 'Bia', title: 'Editor', description: 'Edits text' });
    });

    it('keeps the fields the model does not pass', async () => {
        const tool = createUpdateProfileTool(botStore, bot.id);

        await tool.handler(buildArguments({ title: 'Editor' }), undefined);

        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ name: 'Ana', title: 'Editor', description: 'Helps with mail' });
    });

    it('does not overwrite a field the model did not pass, even if it changed after the turn began', async () => {
        const tool = createUpdateProfileTool(botStore, bot.id);

        await botStore.updateProfile(bot.id, { description: 'Changed elsewhere' });
        await tool.handler(buildArguments({ name: 'Bia' }), undefined);

        await expect(botStore.getById(bot.id))
            .resolves.toMatchObject({ name: 'Bia', description: 'Changed elsewhere' });
    });

    it('reports the saved profile back to the model as text', async () => {
        const tool = createUpdateProfileTool(botStore, bot.id);

        const result = await tool.handler(buildArguments({ name: 'Bia' }), undefined);

        expect(result)
            .toEqual({
                content: [{
                    type: 'text',
                    text: 'Profile updated. Name: Bia. Title: Assistant. Description: Helps with mail',
                }],
            });
    });

    it('returns an error result when the bot does not exist', async () => {
        const tool = createUpdateProfileTool(botStore, 'missing-id');

        const result = await tool.handler(buildArguments({ name: 'Bia' }), undefined);

        expect(result)
            .toMatchObject({ isError: true });
    });
});

describe('PROFILE_TOOL_SHAPE', () => {
    it('trims surrounding whitespace from every field', () => {
        const parsed = profileSchema.parse({ name: '  Bia  ', title: ' Editor ', description: ' Edits text ' });

        expect(parsed)
            .toEqual({ name: 'Bia', title: 'Editor', description: 'Edits text' });
    });

    it('rejects a name that is empty after trimming', () => {
        expect(profileSchema.safeParse({ name: '   ' }).success)
            .toBe(false);
    });

    it('accepts a name of exactly 40 characters and rejects 41', () => {
        expect(profileSchema.safeParse({ name: 'x'.repeat(40) }).success)
            .toBe(true);
        expect(profileSchema.safeParse({ name: 'x'.repeat(41) }).success)
            .toBe(false);
    });

    it('accepts a title of exactly 80 characters and rejects 81', () => {
        expect(profileSchema.safeParse({ title: 'x'.repeat(80) }).success)
            .toBe(true);
        expect(profileSchema.safeParse({ title: 'x'.repeat(81) }).success)
            .toBe(false);
    });

    it('accepts a description of exactly 500 characters and rejects 501', () => {
        expect(profileSchema.safeParse({ description: 'x'.repeat(500) }).success)
            .toBe(true);
        expect(profileSchema.safeParse({ description: 'x'.repeat(501) }).success)
            .toBe(false);
    });
});

describe('createProfileToolServer', () => {
    let opened: OpenedDatabase;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
    });

    afterEach(() => {
        opened.close();
    });

    it('builds an in-process SDK server named cloudbot', () => {
        const botStore = new BotStore(opened.db);
        const server = createProfileToolServer(botStore, 'bot-1');

        expect(server)
            .toMatchObject({ type: 'sdk', name: PROFILE_SERVER_NAME });
    });
});
