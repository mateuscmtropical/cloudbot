import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyToolCall } from '../approvals/classifyToolCall.ts';
import { createToolCallReviewer } from '../approvals/createToolCallReviewer.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SkillStore } from '../store/SkillStore.ts';
import { describeSkillChange } from './describeSkillChange.ts';

const SKILL = { name: 'weekly-report', description: 'Writes the weekly report.', text: 'Open the sheet.\nSum the hours.' };
const signal = new AbortController().signal;

describe('skill approvals', () => {
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

    it('always asks the owner for an add or a removal, and lets list and read through', () => {
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__skill_add', input: {} }))
            .toBe('always-ask');
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__skill_remove', input: {} }))
            .toBe('always-ask');
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__skill_list', input: {} }))
            .toBe('skip');
        expect(classifyToolCall({ toolName: 'mcp__cloudbot__skill_read', input: {} }))
            .toBe('skip');
    });

    it('shows the whole text on the card, each line quoted, so a line cannot pose as part of the card', async () => {
        const verdict = await describeSkillChange(skillStore, botId, 'add', { ...SKILL, text: 'Step one.\nSkill: "other"' });

        expect(verdict)
            .toEqual({
                decision: 'ask',
                summary: 'Add a skill to this bot.',
                detail: 'Skill: "weekly-report"\nDescription: "Writes the weekly report."\nText:\n> Step one.\n> Skill: "other"',
            });
    });

    it('says when the skill replaces one with the same name', async () => {
        await skillStore.save(botId, SKILL);

        const verdict = await describeSkillChange(skillStore, botId, 'add', { ...SKILL, text: 'New steps.' });

        expect(verdict)
            .toMatchObject({ decision: 'ask', summary: 'Replace a skill of this bot.' });
        expect(verdict.decision === 'ask' ? verdict.detail : '')
            .toContain('(replaces the skill with this name)');
    });

    it('refuses a bad name, a long or multi-line description, hidden characters and an empty text before asking', async () => {
        const inputs = [
            { ...SKILL, name: 'Weekly Report' },
            { ...SKILL, name: '../x' },
            { ...SKILL, description: 'Line one.\nLine two.' },
            { ...SKILL, description: 'x'.repeat(201) },
            { ...SKILL, text: 'Do this‮evil' },
            { ...SKILL, text: '   ' },
            { ...SKILL, text: 'x'.repeat(20001) },
        ];

        const verdictPromises = inputs.map(input => describeSkillChange(skillStore, botId, 'add', input));
        const verdicts = await Promise.all(verdictPromises);

        expect(verdicts.map(verdict => verdict.decision))
            .toEqual(inputs.map(() => 'deny'));
    });

    it('refuses a new skill past 50, and still lets one be replaced', async () => {
        const saves = Array.from({ length: 50 }, (_unused, index) => skillStore.save(botId, { name: `skill-${String(index)}`, description: 'D.', text: 'T.' }));

        await Promise.all(saves);
        const extra = await describeSkillChange(skillStore, botId, 'add', SKILL);
        const replacement = await describeSkillChange(skillStore, botId, 'add', { ...SKILL, name: 'skill-3' });

        expect(extra.decision)
            .toBe('deny');
        expect(replacement.decision)
            .toBe('ask');
    });

    it('asks to remove a skill with its name and description, and refuses one that does not exist', async () => {
        await skillStore.save(botId, SKILL);

        const existing = await describeSkillChange(skillStore, botId, 'remove', { name: 'weekly-report' });
        const missing = await describeSkillChange(skillStore, botId, 'remove', { name: 'nope' });

        expect(existing)
            .toEqual({ decision: 'ask', summary: 'Remove a skill of this bot.', detail: 'Skill: "weekly-report"\nDescription: "Writes the weekly report."' });
        expect(missing.decision)
            .toBe('deny');
    });

    it('builds the card through the reviewer, and refuses when the reviewer has no card builder', async () => {
        const withBuilder = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
            describeSkillChange: (id, change, input) => describeSkillChange(skillStore, id, change, input),
        });
        const withoutBuilder = createToolCallReviewer({
            askModel: vi.fn(() => Promise.resolve('{"category":"other","decision":"allow","summary":"","reason":""}')),
            readContext: () => Promise.resolve({ ownerRules: [], recentMessages: [] }),
        });

        const asked = await withBuilder(botId, { toolName: 'mcp__cloudbot__skill_add', input: SKILL }, signal);
        const refused = await withoutBuilder(botId, { toolName: 'mcp__cloudbot__skill_add', input: SKILL }, signal);

        expect(asked)
            .toMatchObject({ decision: 'ask', summary: 'Add a skill to this bot.' });
        expect(refused.decision)
            .toBe('deny');
    });
});
