import { describe, expect, it } from 'vitest';

import type { SavedUpload } from './saveUpload.ts';
import { describeAttachments, readTurnImages } from './attachmentPrompt.ts';
import { buildPng } from './testImages.ts';

function buildUpload(overrides: Partial<SavedUpload>): SavedUpload {
    return {
        id: 'upload-1',
        name: 'file.txt',
        absolutePath: '/uploads/bot-1/file.txt',
        mimeType: 'application/octet-stream',
        sizeBytes: 1,
        bytes: Buffer.from('x'),
        ...overrides,
    };
}

describe('describeAttachments', () => {
    it('lists each saved file with its absolute path, name, type and size', () => {
        const description = describeAttachments([
            buildUpload({ name: 'Report.pdf', absolutePath: '/uploads/bot-1/abc.pdf', mimeType: 'application/pdf', sizeBytes: 12 }),
        ]);

        expect(description)
            .toContain('- /uploads/bot-1/abc.pdf (Report.pdf, application/pdf, 12 bytes)');
    });

    it('returns an empty text when there are no files', () => {
        expect(describeAttachments([]))
            .toBe('');
    });
});

describe('readTurnImages', () => {
    it('builds the image from the bytes kept at upload time, not from disk', () => {
        const pngBytes = buildPng(4, 4);
        const images = readTurnImages([
            buildUpload({ mimeType: 'image/png', absolutePath: '/missing/shot.png', sizeBytes: pngBytes.length, bytes: pngBytes }),
        ]);

        expect(images)
            .toEqual([{ mediaType: 'image/png', data: pngBytes.toString('base64') }]);
    });

    it('skips a truncated image, a fake image and an image over 8000 pixels', () => {
        const wholePng = buildPng(4, 4);
        const images = readTurnImages([
            buildUpload({ mimeType: 'image/png', sizeBytes: 10, bytes: wholePng.subarray(0, 20) }),
            buildUpload({ mimeType: 'image/png', sizeBytes: 5, bytes: Buffer.from('hello') }),
            buildUpload({ mimeType: 'image/png', sizeBytes: 45, bytes: buildPng(8001, 10) }),
            buildUpload({ mimeType: 'image/png', sizeBytes: 45, bytes: buildPng(10, 8001) }),
        ]);

        expect(images)
            .toEqual([]);
    });

    it('keeps an image at exactly 8000 pixels', () => {
        const pngBytes = buildPng(8000, 8000);
        const images = readTurnImages([
            buildUpload({ mimeType: 'image/png', sizeBytes: pngBytes.length, bytes: pngBytes }),
        ]);

        expect(images)
            .toHaveLength(1);
    });

    it('skips files that are not images and images over 5 MB', () => {
        const bigBytes = Buffer.alloc(5 * 1024 * 1024 + 1);
        const images = readTurnImages([
            buildUpload({ mimeType: 'text/plain', sizeBytes: 5, bytes: Buffer.from('hello') }),
            buildUpload({ mimeType: 'image/png', sizeBytes: bigBytes.length, bytes: bigBytes }),
        ]);

        expect(images)
            .toEqual([]);
    });
});
