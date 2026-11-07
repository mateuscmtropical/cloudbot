import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CloudbotTool } from '../agent/createProfileToolServer.ts';
import { BotStore } from '../store/BotStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { SKILL_REVIEW_MIN_TOOL_STEPS, createSkillReviewTool, isSkillReviewDue } from './skillReview.ts';
import type { SkillReviewFacts } from './skillReview.ts';

const DUE: SkillReviewFacts = { isSkillReviewOn: true, source: 'chat', isMainSession: true, isFailed: false, toolSteps: SKILL_REVIEW_MIN_TOOL_STEPS, usedSkillTool: false, skillCount: 0 };

describe('isSkillReviewDue', () => {
    it('is due after a long successful chat turn', () => {
        expect(isSkillReviewDue(DUE))
            .toBe(true);
    });

    it.each<Partial<SkillReviewFacts>>([
        { isSkillReviewOn: false },
        { source: 'checkin' },
        { source: 'compact' },
        { isMainSession: false },
        { isFailed: true },
        { toolSteps: SKILL_REVIEW_MIN_TOOL_STEPS - 1 },
        { usedSkillTool: true },
        { skillCount: 50 },
    ])('is not due for %o', (change) => {
        expect(isSkillReviewDue({ ...DUE, ...change }))
            .toBe(false);
    });
});

describe('skill_review_set', () => {
    let opened: OpenedDatabase;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
    });

    afterEach(() => {
        opened.close();
    });

    it('turns the suggestions off and on for one bot only', async () => {
        const botStore = new BotStore(opened.db);
        const ana = await botStore.create({ name: 'Ana', title: '', description: '' });
        const ben = await botStore.create({ name: 'Ben', title: '', description: '' });
        const setTool: CloudbotTool = createSkillReviewTool(botStore, ana.id);

        expect((await botStore.getById(ana.id))?.isSkillReviewOn)
            .toBe(true);

        await setTool.handler({ isOn: false }, {});

        expect((await botStore.getById(ana.id))?.isSkillReviewOn)
            .toBe(false);
        expect((await botStore.getById(ben.id))?.isSkillReviewOn)
            .toBe(true);

        await setTool.handler({ isOn: true }, {});

        expect((await botStore.getById(ana.id))?.isSkillReviewOn)
            .toBe(true);
    });
});
