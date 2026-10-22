import { tool } from '../agent/cloudbotTool.ts';
import { z } from 'zod/v4';

import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { SkillStore } from '../store/SkillStore.ts';
import { MAX_SKILLS_PER_BOT, MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_TEXT_LENGTH, isSkillInputError, parseSkillInput } from './parseSkillInput.ts';

const SKILL_LIST_TOOL_NAME = 'skill_list';
const SKILL_READ_TOOL_NAME = 'skill_read';
const SKILL_ADD_TOOL_NAME = 'skill_add';
const SKILL_REMOVE_TOOL_NAME = 'skill_remove';
const SKILL_LIST_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SKILL_LIST_TOOL_NAME}`;
const SKILL_READ_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SKILL_READ_TOOL_NAME}`;
const SKILL_ADD_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SKILL_ADD_TOOL_NAME}`;
const SKILL_REMOVE_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SKILL_REMOVE_TOOL_NAME}`;
const SKILL_TOOL_FULL_NAMES = [SKILL_LIST_TOOL_FULL_NAME, SKILL_READ_TOOL_FULL_NAME, SKILL_ADD_TOOL_FULL_NAME, SKILL_REMOVE_TOOL_FULL_NAME];

const LIST_DESCRIPTION = 'List your skills with their names and descriptions.';
const READ_DESCRIPTION = 'Read the whole text of one of your skills by its name. Read it before you do a task the skill covers, and follow its steps.';
const ADD_DESCRIPTION = 'Save a skill: written steps for a task, with a short name and a one-line description. The owner sees the whole text on a card and approves it before it is saved. A skill with the same name is replaced. For a skill from a link, fetch the page first and pass its text.';
const REMOVE_DESCRIPTION = 'Remove one of your skills by its name. The owner approves it first.';

const NAME_SCHEMA = z.string()
    .max(40);
const ADD_SHAPE = {
    name: NAME_SCHEMA,
    description: z.string()
        .max(MAX_SKILL_DESCRIPTION_LENGTH),
    text: z.string()
        .max(MAX_SKILL_TEXT_LENGTH),
};
const NAME_SHAPE = { name: NAME_SCHEMA };

function textResult(text: string, isError: boolean): ProfileToolResult {
    const content = { type: 'text' as const, text };

    return isError ? { content: [content], isError: true } : { content: [content] };
}

// skill_add and skill_remove are offered only with the approval gate, since each waits for the owner.
function createSkillTools(skillStore: SkillStore, botId: string, canChange: boolean): CloudbotTool[] {
    const listTool = tool(
        SKILL_LIST_TOOL_NAME,
        LIST_DESCRIPTION,
        {},
        async (): Promise<ProfileToolResult> => {
            const skills = await skillStore.list(botId);

            if (skills.length === 0) {
                return textResult('This bot has no skills yet.', false);
            }

            const skillLines = skills.map(skill => `- ${skill.name}: ${skill.description}`);
            const listText = skillLines.join('\n');

            return textResult(listText, false);
        },
    );

    const readTool = tool(
        SKILL_READ_TOOL_NAME,
        READ_DESCRIPTION,
        NAME_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const skill = await skillStore.get(botId, args.name);

            return skill === undefined
                ? textResult('This bot has no skill with that name.', true)
                : textResult(skill.text, false);
        },
    );

    // The approval gate has already asked the owner when these run. The input is checked again here, as the model sent it.
    const addTool = tool(
        SKILL_ADD_TOOL_NAME,
        ADD_DESCRIPTION,
        ADD_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const parsed = parseSkillInput(args);

            if (isSkillInputError(parsed)) {
                return textResult(parsed.error, true);
            }

            const skills = await skillStore.list(botId);
            const isReplacing = skills.some(skill => skill.name === parsed.name);

            if (!isReplacing && skills.length >= MAX_SKILLS_PER_BOT) {
                return textResult(`This bot already has ${String(MAX_SKILLS_PER_BOT)} skills. Remove one first.`, true);
            }

            await skillStore.save(botId, parsed);

            return textResult(isReplacing ? `Replaced the skill ${parsed.name}.` : `Saved the skill ${parsed.name}.`, false);
        },
    );

    const removeTool = tool(
        SKILL_REMOVE_TOOL_NAME,
        REMOVE_DESCRIPTION,
        NAME_SHAPE,
        async (args): Promise<ProfileToolResult> => {
            const isRemoved = await skillStore.remove(botId, args.name);

            return isRemoved
                ? textResult(`Removed the skill ${args.name}.`, false)
                : textResult('This bot has no skill with that name.', true);
        },
    );

    return canChange ? [listTool, readTool, addTool, removeTool] : [listTool, readTool];
}

export { SKILL_ADD_TOOL_FULL_NAME, SKILL_LIST_TOOL_FULL_NAME, SKILL_READ_TOOL_FULL_NAME, SKILL_REMOVE_TOOL_FULL_NAME, SKILL_TOOL_FULL_NAMES, createSkillTools };
