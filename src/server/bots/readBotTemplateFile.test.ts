import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_TEMPLATE_BYTES } from './botTemplate.ts';
import { readBotTemplateFile } from './readBotTemplateFile.ts';

const VALID_TEXT = JSON.stringify({ cloudbotTemplate: 1, name: 'Ana', title: 'Helper', description: 'Be brief.' });

describe('readBotTemplateFile', () => {
    let rootDir: string;
    let outsideDir: string;

    beforeEach(async () => {
        const base = await mkdtemp(join(tmpdir(), 'cloudbot-template-read-'));

        rootDir = join(base, 'uploads');
        outsideDir = join(base, 'elsewhere');
        await mkdir(rootDir);
        await mkdir(outsideDir);
    });

    afterEach(async () => {
        await rm(join(rootDir, '..'), { recursive: true, force: true });
    });

    it('reads a template attached in the uploads folder and gives its digest', async () => {
        const filePath = join(rootDir, 'ana.json');

        await writeFile(filePath, VALID_TEXT);
        const result = await readBotTemplateFile(filePath, rootDir);

        expect(result.ok)
            .toBe(true);
        if (result.ok) {
            expect(result.template.name)
                .toBe('Ana');
            expect(result.digest)
                .toHaveLength(64);
        }
    });

    it('refuses a file outside the uploads folder', async () => {
        const filePath = join(outsideDir, 'ana.json');

        await writeFile(filePath, VALID_TEXT);
        const result = await readBotTemplateFile(filePath, rootDir);

        expect(result)
            .toEqual({ ok: false, reason: 'Only a file attached in this chat can be imported.' });
    });

    it('refuses a path that leaves the folder with dots', async () => {
        const filePath = join(rootDir, '..', 'elsewhere', 'ana.json');

        await writeFile(filePath, VALID_TEXT);
        const result = await readBotTemplateFile(filePath, rootDir);

        expect(result.ok)
            .toBe(false);
    });

    it('says the file was not found when it does not exist', async () => {
        const result = await readBotTemplateFile(join(rootDir, 'missing.json'), rootDir);

        expect(result)
            .toEqual({ ok: false, reason: 'The template file was not found. Attach it in this chat first.' });
    });

    it('refuses an oversized file', async () => {
        const filePath = join(rootDir, 'big.json');

        await writeFile(filePath, ' '.repeat(MAX_TEMPLATE_BYTES + 1));
        const result = await readBotTemplateFile(filePath, rootDir);

        expect(result)
            .toEqual({ ok: false, reason: 'The file is larger than 64 KB, so it is not a bot template.' });
    });

    it('refuses a file that is not a template', async () => {
        const filePath = join(rootDir, 'notes.json');

        await writeFile(filePath, '{"hello": "world"}');
        const result = await readBotTemplateFile(filePath, rootDir);

        expect(result.ok)
            .toBe(false);
    });
});
