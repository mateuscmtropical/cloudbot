import { describe, expect, it } from 'vitest';

import { readImageSize } from './readImageSize.ts';
import { buildGif, buildJpeg, buildPng, buildWebp } from './testImages.ts';

describe('readImageSize', () => {
    it('reads the size of a whole image of each type', () => {
        expect(readImageSize(buildPng(640, 480), 'image/png'))
            .toEqual({ width: 640, height: 480 });
        expect(readImageSize(buildJpeg(800, 600), 'image/jpeg'))
            .toEqual({ width: 800, height: 600 });
        expect(readImageSize(buildGif(32, 16), 'image/gif'))
            .toEqual({ width: 32, height: 16 });
        expect(readImageSize(buildWebp(100, 50), 'image/webp'))
            .toEqual({ width: 100, height: 50 });
    });

    it('rejects an image that was cut short', () => {
        const images: [Buffer, string][] = [
            [buildPng(10, 10), 'image/png'],
            [buildJpeg(10, 10), 'image/jpeg'],
            [buildGif(10, 10), 'image/gif'],
            [buildWebp(10, 10), 'image/webp'],
        ];

        images.forEach(([bytes, mimeType]) => {
            const truncated = bytes.subarray(0, bytes.length - 3);

            expect(readImageSize(truncated, mimeType))
                .toBeUndefined();
        });
    });

    it('rejects bytes that only start like an image', () => {
        const signatureOnly = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]);

        expect(readImageSize(signatureOnly, 'image/png'))
            .toBeUndefined();
        expect(readImageSize(Buffer.from('not an image at all, just text'), 'image/jpeg'))
            .toBeUndefined();
        expect(readImageSize(Buffer.alloc(0), 'image/gif'))
            .toBeUndefined();
    });

    it('accepts bytes after the end of a PNG or a JPEG', () => {
        const padding = Buffer.from([0x0A, 0x0A, 0x0A]);

        expect(readImageSize(Buffer.concat([buildPng(7, 9), padding]), 'image/png'))
            .toEqual({ width: 7, height: 9 });
        expect(readImageSize(Buffer.concat([buildJpeg(7, 9), padding]), 'image/jpeg'))
            .toEqual({ width: 7, height: 9 });
    });

    it('handles hostile JPEG segments without a stack overflow', () => {
        const fillBytes = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.alloc(100_000, 0xFF), Buffer.from([0xD9])]);
        const emptySegments = Buffer.concat([
            Buffer.from([0xFF, 0xD8]),
            Buffer.from(Array.from({ length: 30_000 }, () => [0xFF, 0xE0, 0x00, 0x02])
                .flat()),
            Buffer.from([0xFF, 0xD9]),
        ]);

        expect(readImageSize(fillBytes, 'image/jpeg'))
            .toBeUndefined();
        expect(readImageSize(emptySegments, 'image/jpeg'))
            .toBeUndefined();
    });

    it('returns nothing for a type that is not an image', () => {
        expect(readImageSize(buildPng(1, 1), 'text/plain'))
            .toBeUndefined();
    });
});
