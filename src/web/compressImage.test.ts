// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compressImage, scaleToFit } from './compressImage.ts';

describe('compressImage', () => {
    it('fits the longer side in 2048 pixels and keeps the shape', () => {
        expect(scaleToFit(4000, 3000))
            .toEqual({ width: 2048, height: 1536 });
        expect(scaleToFit(1599, 899))
            .toEqual({ width: 1599, height: 899 });
    });

    it('keeps a file that is not a still image', async () => {
        const file = new File(['GIF89a'], 'cat.gif', { type: 'image/gif' });

        const result = await compressImage(file);

        expect(result)
            .toBe(file);
    });

    describe('with a browser that can draw', () => {
        afterEach(() => {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        });

        function stubDrawing(): void {
            const bitmap = { width: 100, height: 100, close: vi.fn() };
            const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '' };
            const redrawn = new Blob(['a redrawn photo that is longer than the first'], { type: 'image/jpeg' });

            vi.stubGlobal('createImageBitmap', vi.fn(() => Promise.resolve(bitmap)));
            vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
                .mockReturnValue(context as unknown as ImageBitmapRenderingContext);
            vi.spyOn(HTMLCanvasElement.prototype, 'toBlob')
                .mockImplementation((callback) => {
                    callback(redrawn);
                });
        }

        it('draws a small JPEG again, even when that makes it larger, so its EXIF data is gone', async () => {
            stubDrawing();

            const file = new File(['exif'], 'photo.jpeg', { type: 'image/jpeg' });
            const result = await compressImage(file);

            expect(result)
                .not.toBe(file);
            expect(result.name)
                .toBe('photo.jpg');
        });

        it('keeps a small PNG as it is', async () => {
            stubDrawing();

            const file = new File(['png'], 'shot.png', { type: 'image/png' });
            const result = await compressImage(file);

            expect(result)
                .toBe(file);
        });
    });

    it('keeps the file when the browser cannot draw it', async () => {
        const file = new File(['not a photo'], 'photo.jpg', { type: 'image/jpeg' });

        const result = await compressImage(file);

        expect(result)
            .toBe(file);
    });
});
