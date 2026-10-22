import type { ToolCallVerdict } from '../approvals/ApprovalGate.ts';
import type { SkillStore } from '../store/SkillStore.ts';
import { MAX_SKILLS_PER_BOT, isSkillInputError, isSkillName, parseSkillInput } from './parseSkillInput.ts';

type SkillChange = 'add' | 'remove';

function readName(input: unknown): string {
    const value: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'name') : undefined;

    return typeof value === 'string' ? value.trim() : '';
}

// Every line of the skill text starts with "> " on the card, so a line of the text can never look like a line of the card.
function quoteLines(text: string): string {
    return text.split('\n')
        .map(line => `> ${line}`)
        .join('\n');
}

// The approval card of a skill change. An add shows the whole text, so the owner reads every step the bot will follow.
// A change the tool would refuse anyway is refused before the owner is asked.
async function describeSkillChange(skillStore: SkillStore, botId: string, change: SkillChange, input: unknown): Promise<ToolCallVerdict> {
    if (change === 'remove') {
        const name = readName(input);
        const skill = isSkillName(name) ? await skillStore.get(botId, name) : undefined;

        if (skill === undefined) {
            return { decision: 'deny', reason: 'This bot has no skill with that name, so there is nothing to remove.' };
        }

        return { decision: 'ask', summary: 'Remove a skill of this bot.', detail: `Skill: ${JSON.stringify(skill.name)}\nDescription: ${JSON.stringify(skill.description)}` };
    }

    const parsed = parseSkillInput(input);

    if (isSkillInputError(parsed)) {
        return { decision: 'deny', reason: parsed.error };
    }

    const skills = await skillStore.list(botId);
    const isReplacing = skills.some(skill => skill.name === parsed.name);

    if (!isReplacing && skills.length >= MAX_SKILLS_PER_BOT) {
        return { decision: 'deny', reason: `This bot already has ${String(MAX_SKILLS_PER_BOT)} skills. Remove one first.` };
    }

    const summary = isReplacing ? 'Replace a skill of this bot.' : 'Add a skill to this bot.';
    const replaceNote = isReplacing ? ' (replaces the skill with this name)' : '';
    const detail = [
        `Skill: ${JSON.stringify(parsed.name)}${replaceNote}`,
        `Description: ${JSON.stringify(parsed.description)}`,
        'Text:',
        quoteLines(parsed.text),
    ].join('\n');

    return { decision: 'ask', summary, detail };
}

export { describeSkillChange };
export type { SkillChange };
