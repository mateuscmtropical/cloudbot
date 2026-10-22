import { hasHiddenCode } from '../text/isHiddenCode.ts';

// A skill name is a short slug, so it reads the same in the prompt, on the card and in a tool call.
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_SKILL_DESCRIPTION_LENGTH = 200;
// The card shows the whole text, so it stays short enough for the owner to read.
const MAX_SKILL_TEXT_LENGTH = 20000;
// The prompt names every skill, so the count is capped.
const MAX_SKILLS_PER_BOT = 50;

interface SkillInput {
    name: string;
    description: string;
    text: string;
}

interface SkillInputError {
    error: string;
}

function readString(input: unknown, field: string): string {
    const value: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, field) : undefined;

    return typeof value === 'string' ? value : '';
}

function isSkillInputError(value: SkillInput | SkillInputError): value is SkillInputError {
    return 'error' in value;
}

function isSkillName(name: string): boolean {
    return SKILL_NAME_PATTERN.test(name);
}

// Checks a skill as the model sent it. Hidden characters are refused, so the card always shows every character.
function parseSkillInput(input: unknown): SkillInput | SkillInputError {
    const name = readString(input, 'name')
        .trim();
    const description = readString(input, 'description')
        .trim();
    const text = readString(input, 'text')
        .trim();

    if (!isSkillName(name)) {
        return { error: 'The skill name must be 1 to 40 lowercase letters, digits or hyphens, such as "weekly-report".' };
    }

    if (description === '' || description.length > MAX_SKILL_DESCRIPTION_LENGTH || /[\r\n]/.test(description)) {
        return { error: `The description must be one line of at most ${String(MAX_SKILL_DESCRIPTION_LENGTH)} characters.` };
    }

    if (text === '' || text.length > MAX_SKILL_TEXT_LENGTH) {
        return { error: `The skill text must have 1 to ${String(MAX_SKILL_TEXT_LENGTH)} characters.` };
    }

    if (hasHiddenCode(description) || hasHiddenCode(text)) {
        return { error: 'The skill has hidden characters, so the card cannot show it whole.' };
    }

    return { name, description, text };
}

export { MAX_SKILLS_PER_BOT, MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_TEXT_LENGTH, isSkillInputError, isSkillName, parseSkillInput };
export type { SkillInput, SkillInputError };
