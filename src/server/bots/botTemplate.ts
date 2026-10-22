import { z } from 'zod/v4';

import { MASCOT_COLOR_NAMES, MASCOT_SHAPES } from '../../shared/mascot.ts';
import type { MascotChoice } from '../../shared/mascot.ts';
import { parseSchedule } from '../routines/schedule.ts';
import type { RoutineSchedule } from '../routines/schedule.ts';
import { isRuleInputError, isToolRuleName, parseRuleInput } from '../rules/parseRuleInput.ts';
import { hasHiddenCode } from '../text/isHiddenCode.ts';

// The format version. A file with another version is refused, so a later format is never read as this one.
const TEMPLATE_VERSION = 1;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 40;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_BLOCKED_TOOLS = 20;
const MAX_ROUTINE_NAME_LENGTH = 60;
const MAX_ROUTINE_PROMPT_LENGTH = 2000;
const MAX_RULES = 20;
const MAX_ROUTINES = 20;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface BotTemplateRule {
    kind: 'allow' | 'block';
    text: string;
    blockedTools: string[];
}

interface BotTemplateRoutine {
    name: string;
    prompt: string;
    schedule: RoutineSchedule;
}

interface BotTemplate {
    cloudbotTemplate: typeof TEMPLATE_VERSION;
    name: string;
    title: string;
    description: string;
    mascot?: MascotChoice;
    rules?: BotTemplateRule[];
    routines?: BotTemplateRoutine[];
}

interface BotTemplateSource {
    name: string;
    title: string;
    description: string;
    mascot: MascotChoice;
    rules: BotTemplateRule[];
    routines: BotTemplateRoutine[];
}

type BotTemplateParseResult = { ok: true; template: BotTemplate } | { ok: false; reason: string };

// A name or title is one line. Carriage returns, line breaks and tabs are refused along with hidden characters.
function isOneLine(value: string): boolean {
    return !/[\r\n\t]/.test(value) && !hasHiddenCode(value);
}

// Descriptions, rules and prompts may have line breaks and tabs. A Windows line end is read as a plain line break.
function isPlainText(value: string): boolean {
    const withUnixLineEnds = value.replaceAll('\r\n', '\n');

    return !hasHiddenCode(withUnixLineEnds);
}

const ONE_LINE_MESSAGE = 'Use one line of plain text without hidden characters.';
const PLAIN_TEXT_MESSAGE = 'Use plain text without hidden characters.';
const TOOL_NAME_MESSAGE = 'Each blocked tool must be a tool name such as Bash or WebFetch.';

const toolNameSchema = z.string()
    .trim()
    .min(1)
    .refine(name => !hasHiddenCode(name) && isToolRuleName(name), TOOL_NAME_MESSAGE);
const blockedToolsSchema = z.array(toolNameSchema)
    .max(MAX_BLOCKED_TOOLS)
    .optional();

const ruleSchema = z.object({
    kind: z.enum(['allow', 'block']),
    text: z.string()
        .refine(isPlainText, PLAIN_TEXT_MESSAGE),
    blockedTools: blockedToolsSchema,
})
    .strict();

const routineSchema = z.object({
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_ROUTINE_NAME_LENGTH)
        .refine(isOneLine, ONE_LINE_MESSAGE),
    prompt: z.string()
        .trim()
        .min(1)
        .max(MAX_ROUTINE_PROMPT_LENGTH)
        .refine(isPlainText, PLAIN_TEXT_MESSAGE),
    schedule: z.unknown(),
})
    .strict();

const mascotSchema = z.object({
    color: z.enum(MASCOT_COLOR_NAMES),
    shape: z.enum(MASCOT_SHAPES),
})
    .strict();

const templateSchema = z.object({
    cloudbotTemplate: z.literal(TEMPLATE_VERSION),
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_NAME_LENGTH)
        .refine(isOneLine, ONE_LINE_MESSAGE),
    title: z.string()
        .trim()
        .min(1)
        .max(MAX_TITLE_LENGTH)
        .refine(isOneLine, ONE_LINE_MESSAGE),
    description: z.string()
        .trim()
        .max(MAX_DESCRIPTION_LENGTH)
        .refine(isPlainText, PLAIN_TEXT_MESSAGE)
        .optional(),
    mascot: mascotSchema.optional(),
    rules: z.array(ruleSchema)
        .max(MAX_RULES)
        .optional(),
    routines: z.array(routineSchema)
        .max(MAX_ROUTINES)
        .optional(),
})
    .strict();

// Builds the template from the bot's own fields. Only these fields leave the bot, so no secret, token,
// webhook URL, sign-in session, upload or memory file can end up in the file.
function buildBotTemplate(source: BotTemplateSource): BotTemplate {
    return {
        cloudbotTemplate: TEMPLATE_VERSION,
        name: source.name,
        title: source.title,
        description: source.description,
        mascot: source.mascot,
        rules: source.rules,
        routines: source.routines,
    };
}

// One line for a schedule, in the same words the owner would use.
function describeSchedule(schedule: RoutineSchedule): string {
    if (schedule.kind === 'interval') {
        return `every ${String(schedule.everyMinutes)} minutes`;
    }

    const time = `${String(schedule.hour)
        .padStart(2, '0')}:${String(schedule.minute)
        .padStart(2, '0')} UTC`;

    if (schedule.kind === 'daily') {
        return `every day at ${time}`;
    }

    const weekdayName = WEEKDAY_NAMES[schedule.weekday] ?? 'an unknown day';

    return `every ${weekdayName} at ${time}`;
}

// The card text for the owner. Text the bot wrote is quoted, so a line break in it cannot start a new section.
const RULES_NOTE = 'Allow rules widen what the bot may do.';

function describeBotTemplate(template: BotTemplate): string {
    const mascotLine = template.mascot === undefined ? 'a random look' : `${template.mascot.color}, ${template.mascot.shape}`;
    const ruleLines = (template.rules ?? []).map(describeRule);
    const routineLines = (template.routines ?? []).map(describeRoutine);

    return [
        `Name: ${JSON.stringify(template.name)}`,
        `Title: ${JSON.stringify(template.title)}`,
        `Look: ${mascotLine}`,
        `Description: ${JSON.stringify(template.description)}`,
        'Rules:',
        ...(ruleLines.length === 0 ? ['none'] : [RULES_NOTE, ...ruleLines]),
        'Routines (created turned off):',
        ...(routineLines.length === 0 ? ['none'] : routineLines),
    ].join('\n');
}

function describeRule(rule: BotTemplateRule): string {
    const kindLabel = rule.kind === 'block' ? 'Block' : 'Allow';
    const quotedTools = rule.blockedTools.map(name => JSON.stringify(name));
    const toolsText = quotedTools.length === 0 ? '' : ` (blocked tools: ${quotedTools.join(', ')})`;

    return `- ${kindLabel}: ${JSON.stringify(rule.text)}${toolsText}`;
}

function describeRoutine(routine: BotTemplateRoutine): string {
    return `- ${JSON.stringify(routine.name)}, ${describeSchedule(routine.schedule)}: ${JSON.stringify(routine.prompt)}`;
}

function serializeBotTemplate(template: BotTemplate): string {
    return `${JSON.stringify(template, null, 2)}\n`;
}

// The file name of the export. Only letters and digits stay, and the name falls back to "bot".
function templateFileName(botName: string): string {
    const lowerName = botName.toLowerCase();
    const wordsOnly = lowerName.replace(/[^a-z0-9]+/g, '-');
    const trimmed = wordsOnly.replace(/^-+|-+$/g, '');

    return `${trimmed === '' ? 'bot' : trimmed}-template.json`;
}

// The message is written for the owner or the bot, so it says what to change.
function parseBotTemplate(text: string): BotTemplateParseResult {
    if (Buffer.byteLength(text, 'utf8') > MAX_TEMPLATE_BYTES) {
        return { ok: false, reason: 'The file is larger than 64 KB, so it is not a bot template.' };
    }

    const raw = parseJson(text);

    if (raw === undefined || typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { ok: false, reason: 'The file is not a bot template. It must be a JSON object.' };
    }

    const version: unknown = Reflect.get(raw, 'cloudbotTemplate');

    if (version === undefined) {
        return { ok: false, reason: 'The file has no cloudbotTemplate version, so it is not a bot template.' };
    }

    if (version !== TEMPLATE_VERSION) {
        return { ok: false, reason: `This template has format version ${JSON.stringify(version)}. This CloudBot reads version ${String(TEMPLATE_VERSION)}.` };
    }

    const parsed = templateSchema.safeParse(raw);

    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined
            ? ''
            : issue.path.map(part => String(part))
                    .join('.');

        const location = where === '' ? '' : ` at ${where}`;

        return { ok: false, reason: `The template is not valid${location}: ${issue?.message ?? 'not accepted'}.` };
    }

    const data = parsed.data;
    const routines = data.routines ?? [];
    const routineSchedules = routines.map(routine => parseSchedule(routine.schedule));
    const badRoutineIndex = routineSchedules.findIndex(schedule => schedule === undefined);

    if (badRoutineIndex !== -1) {
        return { ok: false, reason: `The schedule of routine ${String(badRoutineIndex + 1)} is not valid.` };
    }

    const ruleResults = (data.rules ?? []).map(rule => parseRuleInput({ kind: rule.kind, text: rule.text, blockedTools: rule.blockedTools }));
    const badRuleIndex = ruleResults.findIndex(isRuleInputError);
    const badRule = ruleResults[badRuleIndex];

    if (badRule !== undefined && isRuleInputError(badRule)) {
        return { ok: false, reason: `Rule ${String(badRuleIndex + 1)} is not valid. ${badRule.error}` };
    }

    const rules = ruleResults.filter((result): result is BotTemplateRule => !isRuleInputError(result));
    const template: BotTemplate = {
        cloudbotTemplate: TEMPLATE_VERSION,
        name: data.name,
        title: data.title,
        description: data.description ?? '',
        ...(data.mascot === undefined ? {} : { mascot: data.mascot }),
        ...(data.rules === undefined ? {} : { rules }),
        ...(data.routines === undefined ? {} : { routines: buildRoutines(routines, routineSchedules) }),
    };

    return { ok: true, template };
}

// The schedules were checked before this runs, so each one is set.
function buildRoutines(routines: { name: string; prompt: string }[], schedules: (RoutineSchedule | undefined)[]): BotTemplateRoutine[] {
    return routines.map((routine, index) => ({
        name: routine.name,
        prompt: routine.prompt,
        schedule: schedules[index] as RoutineSchedule,
    }));
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export {
    MAX_BLOCKED_TOOLS,
    MAX_DESCRIPTION_LENGTH,
    MAX_NAME_LENGTH,
    MAX_RULES,
    MAX_TEMPLATE_BYTES,
    MAX_TITLE_LENGTH,
    TEMPLATE_VERSION,
    buildBotTemplate,
    describeBotTemplate,
    describeSchedule,
    isOneLine,
    isPlainText,
    parseBotTemplate,
    serializeBotTemplate,
    templateFileName,
};
export type { BotTemplate, BotTemplateParseResult, BotTemplateRoutine, BotTemplateRule, BotTemplateSource };
