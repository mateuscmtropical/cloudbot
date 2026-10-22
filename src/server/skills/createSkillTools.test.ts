import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SkillStore } from '../store/SkillStore.ts';
import { createSkillTools } from './createSkillTools.ts';

async function run(tools: CloudbotTool[], name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const found = tools.find(candidate => candidate.name === name);

    if (found === undefined) {
        throw new Error(`No tool ${name}`);
    }

    const result = await found.handler(args, {});
    const first = result.content[0] as { text?: string } | undefined;

    return { text: first?.text ?? '', isError: result.isError === true };
}

describe('skill tools', () => {
    let opened: OpenedDatabase;
    let skillStore: SkillStore;
    let botId: string;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        skillStore = new SkillStore(opened.db);
        const botStore = new BotStore(opened.db);
        const bot = await botStore.create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
    });

    afterEach(() => {
        opened.close();
    });

    it('offers only list and read without the approval gate', () => {
        const names = createSkillTools(skillStore, botId, false)
            .map(item => item.name);

        expect(names)
            .toEqual(['skill_list', 'skill_read']);
    });

    it('saves, lists, reads, replaces and removes a skill', async () => {
        const tools = createSkillTools(skillStore, botId, true);

        const saved = await run(tools, 'skill_add', { name: 'weekly-report', description: 'Writes the report.', text: 'Step 1.' });
        const replaced = await run(tools, 'skill_add', { name: 'weekly-report', description: 'Writes the report.', text: 'Step 2.' });
        const listed = await run(tools, 'skill_list', {});
        const read = await run(tools, 'skill_read', { name: 'weekly-report' });
        const removed = await run(tools, 'skill_remove', { name: 'weekly-report' });
        const readAgain = await run(tools, 'skill_read', { name: 'weekly-report' });

        expect([saved.text, replaced.text])
            .toEqual(['Saved the skill weekly-report.', 'Replaced the skill weekly-report.']);
        expect(listed.text)
            .toBe('- weekly-report: Writes the report.');
        expect(read.text)
            .toBe('Step 2.');
        expect(removed.text)
            .toBe('Removed the skill weekly-report.');
        expect(readAgain.isError)
            .toBe(true);
    });

    it('checks the input again when it runs, as the model sent it', async () => {
        const tools = createSkillTools(skillStore, botId, true);

        const result = await run(tools, 'skill_add', { name: 'Bad Name', description: 'D.', text: 'T.' });

        expect(result.isError)
            .toBe(true);
        expect(await skillStore.list(botId))
            .toEqual([]);
    });
});
