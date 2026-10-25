import { describe, expect, it } from 'vitest';

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

    it('keeps the file when the browser cannot draw it', async () => {
        const file = new File(['not a photo'], 'photo.jpg', { type: 'image/jpeg' });

        const result = await compressImage(file);

        expect(result)
            .toBe(file);
    });
});
