import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectImageMimeType, readMaxUploadBytes, saveFiles } from './saveUpload.ts';

const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.from('rest of the image'),
]);

describe('saveFiles', () => {
    let uploadDir: string;

    beforeEach(async () => {
        const root = await mkdtemp(join(tmpdir(), 'cloudbot-upload-'));

        uploadDir = join(root, 'bot-1');
    });

    afterEach(async () => {
        await rm(join(uploadDir, '..'), { recursive: true, force: true });
    });

    it('saves a file under a generated name and keeps its bytes and details', async () => {
        const savedFiles = await saveFiles(uploadDir, [new File([PNG_BYTES], 'Screenshot.PNG')]);
        const saved = savedFiles[0];

        expect(saved?.absolutePath)
            .toMatch(/[\\/][0-9a-f-]{36}\.png$/);
        expect(saved?.name)
            .toBe('Screenshot.PNG');
        expect(saved?.mimeType)
            .toBe('image/png');
        expect(saved?.sizeBytes)
            .toBe(PNG_BYTES.length);
        expect(saved?.bytes)
            .toEqual(PNG_BYTES);
        expect(await readFile(saved?.absolutePath ?? ''))
            .toEqual(PNG_BYTES);
    });

    it('keeps a file name that tries to leave the folder inside the upload folder', async () => {
        const savedFiles = await saveFiles(uploadDir, [new File(['hi'], '../../escape.txt')]);
        const saved = savedFiles[0];

        expect(saved?.name)
            .toBe('escape.txt');
        expect(await readdir(uploadDir))
            .toHaveLength(1);
        expect(saved?.absolutePath.startsWith(uploadDir))
            .toBe(true);
    });

    it('drops an extension that is not a plain short one', async () => {
        const savedFiles = await saveFiles(uploadDir, [new File(['x'], 'run.sh;rm -rf')]);
        const saved = savedFiles[0];

        expect(saved?.absolutePath)
            .toMatch(/[\\/][0-9a-f-]{36}$/);
    });

    it('cuts a long display name by code points, so no emoji is split', async () => {
        const savedFiles = await saveFiles(uploadDir, [new File(['x'], '\u{1F600}'.repeat(130))]);

        expect(savedFiles[0]?.name)
            .toBe('\u{1F600}'.repeat(120));
    });

    it('saves every file of one request', async () => {
        const savedFiles = await saveFiles(uploadDir, [
            new File(['1'], 'one.txt'),
            new File(['2'], 'two.txt'),
        ]);

        expect(savedFiles.map(file => file.name))
            .toEqual(['one.txt', 'two.txt']);
    });

    it('removes the files already written when one file of the request fails', async () => {
        const broken = { name: 'bad.txt', arrayBuffer: () => Promise.reject(new Error('disk error')) } as unknown as File;

        await expect(saveFiles(uploadDir, [new File(['ok'], 'good.txt'), broken]))
            .rejects.toThrow('disk error');
        expect(await readdir(uploadDir))
            .toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('keeps the folder and file modes under a strict umask', async () => {
        const previousUmask = process.umask(0o077);

        try {
            const savedFiles = await saveFiles(uploadDir, [new File(['x'], 'a.txt')]);
            const folderStat = await stat(uploadDir);
            const fileStat = await stat(savedFiles[0]?.absolutePath ?? '');

            expect(folderStat.mode & 0o7777)
                .toBe(0o2750);
            expect(fileStat.mode & 0o777)
                .toBe(0o640);
        } finally {
            process.umask(previousUmask);
        }
    });
});

describe('readMaxUploadBytes', () => {
    it('defaults to 20 MB', () => {
        expect(readMaxUploadBytes({}))
            .toBe(20 * 1024 * 1024);
    });

    it('uses CLOUDBOT_MAX_UPLOAD_MB when it is a positive number', () => {
        expect(readMaxUploadBytes({ CLOUDBOT_MAX_UPLOAD_MB: '5' }))
            .toBe(5 * 1024 * 1024);
    });

    it('uses the default for a value that is not a positive number', () => {
        expect(readMaxUploadBytes({ CLOUDBOT_MAX_UPLOAD_MB: 'abc' }))
            .toBe(20 * 1024 * 1024);
        expect(readMaxUploadBytes({ CLOUDBOT_MAX_UPLOAD_MB: '0' }))
            .toBe(20 * 1024 * 1024);
    });
});

describe('detectImageMimeType', () => {
    it('recognizes png, jpeg, gif and webp by their first bytes', () => {
        expect(detectImageMimeType(PNG_BYTES))
            .toBe('image/png');
        expect(detectImageMimeType(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])))
            .toBe('image/jpeg');
        expect(detectImageMimeType(Buffer.from('GIF89a....')))
            .toBe('image/gif');
        expect(detectImageMimeType(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP')))
            .toBe('image/webp');
    });

    it('returns undefined for text', () => {
        expect(detectImageMimeType(Buffer.from('plain text')))
            .toBeUndefined();
    });
});
