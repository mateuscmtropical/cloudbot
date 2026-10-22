import { hasHiddenCode } from '../text/isHiddenCode.ts';

// A skill name is a short slug, so it reads the same in the prompt, on the card and in a tool call.
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_SKILL_DESCRIPTION_LENGTH = 200;
// The card shows the whole text, so it stays as short as other cards (MAX_CARD_CHARS in createToolCallReviewer.ts).
const MAX_SKILL_TEXT_LENGTH = 12000;
// Characters that show nothing on the card but which hasHiddenCode lets through: variation selectors, the combining
// grapheme joiner and the blank fillers. A skill often comes from a fetched page, where hidden text can be planted.
const INVISIBLE_CODES = new Set([0x034F, 0x115F, 0x1160, 0x3164, 0xFFA0]);
// Spaces other than the plain one, and tabs, can push text to a new screen line on the card without a "> " in front.
// A long run of plain spaces can do the same, so runs are capped.
const ODD_SPACE_PATTERN = /[\t\v\f\r\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]| {9,}/;
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

function isInvisibleCode(code: number): boolean {
    const isVariationSelector = (code >= 0xFE00 && code <= 0xFE0F) || (code >= 0xE0100 && code <= 0xE01EF);

    return isVariationSelector || INVISIBLE_CODES.has(code);
}

function hasInvisibleCode(text: string): boolean {
    return Array.from(text)
        .some((character) => {
            const code = character.codePointAt(0) ?? 0;

            return isInvisibleCode(code);
        });
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

    if (hasHiddenCode(description) || hasHiddenCode(text) || hasInvisibleCode(description) || hasInvisibleCode(text)) {
        return { error: 'The skill has hidden characters, so the card cannot show it whole.' };
    }

    if (ODD_SPACE_PATTERN.test(description) || ODD_SPACE_PATTERN.test(text)) {
        return { error: 'The skill has tabs, unusual spaces or long runs of spaces. Use plain spaces, at most 8 in a row.' };
    }

    return { name, description, text };
}

export { MAX_SKILLS_PER_BOT, MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_TEXT_LENGTH, isSkillInputError, isSkillName, parseSkillInput };
export type { SkillInput, SkillInputError };
