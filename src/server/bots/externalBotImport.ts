import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';

import { z } from 'zod/v4';

import { hasHiddenCode } from '../text/isHiddenCode.ts';

const MAX_EXTERNAL_BOT_FILE_BYTES = 64 * 1024;
const MAX_IMPORTED_INSTRUCTIONS_LENGTH = 12_000;
const MAX_IMPORTED_NAME_LENGTH = 40;
const MAX_IMPORTED_TITLE_LENGTH = 80;
const MAX_IMPORTED_DESCRIPTION_LENGTH = 500;
const IMPORTABLE_EXTENSIONS = new Set(['.json', '.md', '.txt']);
const OMITTED_IMPORT_CONTENT = 'Platform actions, tools, skills, files, credentials, approval settings and routines are not imported. CloudBot rules and permissions are not changed. Add credentials again through the secure form.';

interface BotImportDraft {
    name: string;
    title: string;
    description: string;
    instructions: string;
}

interface ExternalBotFileOk {
    ok: true;
    draft: BotImportDraft;
    digest: string;
}

interface ExternalBotFileRefused {
    ok: false;
    reason: string;
}

interface BotImportDraftOk {
    ok: true;
    draft: BotImportDraft;
}

type ExternalBotFileResult = ExternalBotFileOk | ExternalBotFileRefused;

type BotImportDraftResult = BotImportDraftOk | ExternalBotFileRefused;

interface ExternalBotJson {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    instructions?: unknown;
    system_prompt?: unknown;
    systemPrompt?: unknown;
    prompt?: unknown;
    rules?: unknown;
}

const BOT_IMPORT_TEXT_SHAPE = {
    name: z.string()
        .trim()
        .min(1)
        .max(MAX_IMPORTED_NAME_LENGTH)
        .refine(isOneLine, 'The name must be one line of plain text.'),
    title: z.string()
        .trim()
        .min(1)
        .max(MAX_IMPORTED_TITLE_LENGTH)
        .refine(isOneLine, 'The title must be one line of plain text.'),
    description: z.string()
        .trim()
        .max(MAX_IMPORTED_DESCRIPTION_LENGTH)
        .refine(isPlainText, 'The description must be plain text.'),
    instructions: z.string()
        .trim()
        .min(1)
        .max(MAX_IMPORTED_INSTRUCTIONS_LENGTH)
        .refine(isPlainText, 'The instructions must be plain text.'),
};

function isOneLine(value: string): boolean {
    return !/[\r\n\t]/.test(value) && !hasHiddenCode(value);
}

function isPlainText(value: string): boolean {
    const withUnixLineEnds = value.replaceAll('\r\n', '\n');

    return !hasHiddenCode(withUnixLineEnds);
}

function parseBotImportDraft(input: unknown): BotImportDraftResult {
    const parsed = z.object(BOT_IMPORT_TEXT_SHAPE)
        .strict()
        .safeParse(input);

    if (!parsed.success) {
        return { ok: false, reason: 'The imported bot draft is not valid. Check its name, description and instructions.' };
    }

    const draft: BotImportDraft = {
        name: redactRecognizableSecrets(parsed.data.name),
        title: redactRecognizableSecrets(parsed.data.title),
        description: redactRecognizableSecrets(parsed.data.description),
        instructions: redactRecognizableSecrets(parsed.data.instructions),
    };

    return { ok: true, draft };
}

function describeBotImportDraft(input: unknown): string | undefined {
    const parsed = parseBotImportDraft(input);

    if (!parsed.ok) {
        return undefined;
    }

    const { draft } = parsed;

    return [
        `Name: ${JSON.stringify(draft.name)}`,
        `Title: ${JSON.stringify(draft.title)}`,
        `Description: ${JSON.stringify(draft.description)}`,
        'Imported rules and instructions (saved as memory text, not as permissions):',
        JSON.stringify(draft.instructions),
        `Not imported: ${OMITTED_IMPORT_CONTENT}`,
    ].join('\n');
}

async function readExternalBotFile(filePath: string, uploadRoot: string): Promise<ExternalBotFileResult> {
    const realFile = await realpath(filePath)
        .catch(() => undefined);

    if (realFile === undefined) {
        return { ok: false, reason: 'The file was not found. Attach it in this chat first.' };
    }

    const realRoot = await realpath(uploadRoot)
        .catch(() => undefined);

    if (realRoot === undefined) {
        return { ok: false, reason: 'Only a file attached in this chat can be imported.' };
    }

    const relativePath = relative(realRoot, realFile);
    const isInside = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);

    if (!isInside) {
        return { ok: false, reason: 'Only a file attached in this chat can be imported.' };
    }

    const extension = extname(realFile)
        .toLowerCase();

    if (!IMPORTABLE_EXTENSIONS.has(extension)) {
        return { ok: false, reason: 'Attach a plain text, Markdown or JSON instructions file.' };
    }

    const fileInfo = await stat(realFile);

    if (!fileInfo.isFile()) {
        return { ok: false, reason: 'The file was not found. Attach it in this chat first.' };
    }

    if (fileInfo.size > MAX_EXTERNAL_BOT_FILE_BYTES) {
        return { ok: false, reason: 'The instructions file is larger than 64 KB.' };
    }

    const sourceText = await readFile(realFile, 'utf8');
    const parsed = parseExternalBotText(sourceText, extension);

    if (!parsed.ok) {
        return parsed;
    }

    const digest = createHash('sha256')
        .update(sourceText)
        .digest('hex');

    return { ok: true, draft: parsed.draft, digest };
}

function parseExternalBotText(sourceText: string, extension: string): BotImportDraftResult {
    if (Buffer.byteLength(sourceText, 'utf8') > MAX_EXTERNAL_BOT_FILE_BYTES) {
        return { ok: false, reason: 'The instructions file is larger than 64 KB.' };
    }

    if (extension === '.json') {
        const parsedJson = parseJson(sourceText);

        if (!isRecord(parsedJson)) {
            return { ok: false, reason: 'The JSON export must be an object with instructions.' };
        }

        return buildJsonDraft(parsedJson);
    }

    if (extension !== '.txt' && extension !== '.md') {
        return { ok: false, reason: 'Attach a plain text, Markdown or JSON instructions file.' };
    }

    return buildDraft({
        name: 'Imported bot',
        title: 'Imported assistant',
        description: '',
        instructions: sourceText,
    });
}

function buildJsonDraft(source: ExternalBotJson): BotImportDraftResult {
    const instructionFields = [source.instructions, source.system_prompt, source.systemPrompt, source.prompt];
    const instructionText = instructionFields.find((value): value is string => typeof value === 'string');
    const ruleText = readJsonRules(source.rules);
    const instructions = [instructionText, ruleText]
        .filter((value): value is string => value !== undefined && value.trim() !== '')
        .join('\n\n');

    if (instructions.trim() === '') {
        return { ok: false, reason: 'The JSON export has no supported instructions or text rules.' };
    }

    const name = typeof source.name === 'string' ? source.name : 'Imported bot';
    const title = typeof source.title === 'string' ? source.title : 'Imported assistant';
    const description = typeof source.description === 'string' ? source.description : '';

    return buildDraft({ name, title, description, instructions });
}

function readJsonRules(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const textRules = value.filter((rule): rule is string => typeof rule === 'string');

    return textRules.join('\n');
}

function buildDraft(source: BotImportDraft): BotImportDraftResult {
    const parsed = parseBotImportDraft({
        name: source.name,
        title: source.title,
        description: source.description,
        instructions: source.instructions,
    });

    if (!parsed.ok) {
        return { ok: false, reason: parsed.reason };
    }

    return parsed;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is ExternalBotJson {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactRecognizableSecrets(text: string): string {
    const withoutLabeledValues = text.replace(/\b([A-Z0-9_]*(?:api[ _-]?key|client[ _-]?secret|password|passwd|token|secret|credential|private[ _-]?key|access[ _-]?key|key))\b(\s*[:=]\s*|\s+(?:is|equals)\s+)(?:"([^"]*)"|'([^']*)'|([^\s,;]+))/gi, '$1$2[redacted]');
    const withoutBearerValues = withoutLabeledValues.replace(/\bBearer\s+([^\s,;]+)/gi, redactBearerValue);
    const withoutRecognizedTokens = withoutBearerValues.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted secret]');

    return withoutRecognizedTokens;
}

function redactBearerValue(_match: string, value: string): string {
    const punctuationMatch = value.match(/[.,!?]+$/);
    const trailingPunctuation = punctuationMatch?.[0] ?? '';

    return `Bearer [redacted]${trailingPunctuation}`;
}

export { BOT_IMPORT_TEXT_SHAPE, MAX_EXTERNAL_BOT_FILE_BYTES, MAX_IMPORTED_INSTRUCTIONS_LENGTH, OMITTED_IMPORT_CONTENT, describeBotImportDraft, parseBotImportDraft, readExternalBotFile };
export type { BotImportDraft, BotImportDraftOk, BotImportDraftResult, ExternalBotFileResult };
