import { z } from 'zod/v4';

import { tool } from '../agent/cloudbotTool.ts';
import type { CloudbotTool, ProfileToolResult } from '../agent/createProfileToolServer.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { BotStore } from '../store/BotStore.ts';
import { QUIET_REPLY } from '../routines/checkin.ts';
import { MAX_SKILLS_PER_BOT } from './parseSkillInput.ts';

// A turn needs this many tool calls that worked before the bot looks back at it for a skill. Short turns are routine.
const SKILL_REVIEW_MIN_TOOL_STEPS = 8;

const SKILL_REVIEW_TOOL_NAME = 'skill_review_set';
const SKILL_REVIEW_TOOL_FULL_NAME = `mcp__${PROFILE_SERVER_NAME}__${SKILL_REVIEW_TOOL_NAME}`;
const SKILL_REVIEW_DESCRIPTION = 'Turn the skill suggestions of this bot on or off. When on, after a long turn that went well, the bot may propose a skill from it, and the owner approves the text on a card first. Use it when the owner asks to stop or to start these suggestions.';

interface SkillReviewFacts {
    isSkillReviewOn: boolean;
    source: string;
    // True for a turn of the main session. A side session has no context size.
    isMainSession: boolean;
    isFailed: boolean;
    toolSteps: number;
    // True when the turn read or changed a skill, so a skill already covers the work or a proposal was made.
    usedSkillTool: boolean;
    skillCount: number;
}

// Only the owner's own chat turns count. A check-in, a routine or a webhook repeats work the owner already set up.
function isSkillReviewDue(facts: SkillReviewFacts): boolean {
    return facts.isSkillReviewOn
        && facts.source === 'chat'
        && facts.isMainSession
        && !facts.isFailed
        && !facts.usedSkillTool
        && facts.toolSteps >= SKILL_REVIEW_MIN_TOOL_STEPS
        && facts.skillCount < MAX_SKILLS_PER_BOT;
}

// Sent in the same session after the turn, so the bot still has the work in view. Its reply is quiet, so ChatService drops the run.
function buildSkillReviewMessage(): string {
    return `Look back at the task you just finished. If it was a procedure worth repeating, with steps that worked and that you would need again, call skill_add once with a short name, a one-line description and the steps. The owner reads the whole text on a card and approves it before it is saved. Skip it when your skills already cover the task, when it was a one-off, or when the steps hold anything private such as keys, passwords or personal data. Call skill_add at most once. Then reply with exactly ${QUIET_REPLY} and nothing else.`;
}

function createSkillReviewTool(botStore: BotStore, botId: string): CloudbotTool {
    return tool(
        SKILL_REVIEW_TOOL_NAME,
        SKILL_REVIEW_DESCRIPTION,
        { isOn: z.boolean() },
        async (args): Promise<ProfileToolResult> => {
            await botStore.setSkillReview(botId, args.isOn);

            return { content: [{ type: 'text', text: args.isOn ? 'Skill suggestions are on.' : 'Skill suggestions are off.' }] };
        },
    );
}

export { SKILL_REVIEW_MIN_TOOL_STEPS, SKILL_REVIEW_TOOL_FULL_NAME, buildSkillReviewMessage, createSkillReviewTool, isSkillReviewDue };
export type { SkillReviewFacts };
