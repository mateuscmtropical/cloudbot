import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import type { BotTemplate } from './botTemplate.ts';
import { MAX_TEMPLATE_BYTES, parseBotTemplate } from './botTemplate.ts';

const NOT_FOUND_REASON = 'The template file was not found. Attach it in this chat first.';
const NOT_ATTACHED_REASON = 'Only a file attached in this chat can be imported.';

// Reads a template the owner attached. The path is resolved through links first, so a link cannot point
// the import at a file outside the uploads folder.
async function readBotTemplateFile(filePath: string, uploadRoot: string): Promise<BotTemplateFileResult> {
    const located = await locateFile(filePath, uploadRoot);

    if (located === undefined) {
        return { ok: false, reason: NOT_FOUND_REASON };
    }

    if (located.kind === 'outside') {
        return { ok: false, reason: NOT_ATTACHED_REASON };
    }

    const info = await stat(located.realFile);

    if (!info.isFile()) {
        return { ok: false, reason: NOT_FOUND_REASON };
    }

    if (info.size > MAX_TEMPLATE_BYTES) {
        return { ok: false, reason: 'The file is larger than 64 KB, so it is not a bot template.' };
    }

    const text = await readFile(located.realFile, 'utf8');
    const parsed = parseBotTemplate(text);

    if (!parsed.ok) {
        return parsed;
    }

    const digest = createHash('sha256')
        .update(text)
        .digest('hex');

    return { ok: true, template: parsed.template, digest };
}

interface BotTemplateFileOk {
    ok: true;
    template: BotTemplate;
    // The SHA-256 of the file text, so an import can check the file is the one the owner was shown.
    digest: string;
}

type BotTemplateFileResult = BotTemplateFileOk | { ok: false; reason: string };

interface InsideFile {
    kind: 'inside';
    realFile: string;
}

interface OutsideFile {
    kind: 'outside';
}

type LocatedFile = InsideFile | OutsideFile;

// A bot with no uploads has no folder yet, so no file can be inside it.
async function locateFile(filePath: string, uploadRoot: string): Promise<LocatedFile | undefined> {
    const realFile = await realpath(filePath)
        .catch(() => undefined);

    if (realFile === undefined) {
        return undefined;
    }

    const realRoot = await realpath(uploadRoot)
        .catch(() => undefined);

    if (realRoot === undefined) {
        return { kind: 'outside' };
    }

    const relativePath = relative(realRoot, realFile);
    const isInside = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);

    return isInside ? { kind: 'inside', realFile } : { kind: 'outside' };
}

export { readBotTemplateFile };
export type { BotTemplateFileResult };
