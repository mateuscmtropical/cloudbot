import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TurnImage } from './AgentRunner.ts';
import { writeCodexTurnImages } from './writeCodexTurnImages.ts';

describe('writeCodexTurnImages', () => {
    it('writes each image to a private file in a new folder, and removes the folder', () => {
        const home = mkdtempSync(join(tmpdir(), 'cloudbot-codex-images-'));

        const images = writeCodexTurnImages(home, [{ mediaType: 'image/webp', data: 'UklGRg==' }]);
        const [path = ''] = images.paths;

        expect(path.endsWith('image-1.webp'))
            .toBe(true);
        expect(readFileSync(path)
            .toString('base64'))
            .toBe('UklGRg==');
        if (process.platform !== 'win32') {
            expect(statSync(path).mode & 0o777)
                .toBe(0o600);
        }
        images.remove();
        expect(readdirSync(home))
            .toEqual([]);
    });

    it('writes nothing for a turn without images', () => {
        const home = mkdtempSync(join(tmpdir(), 'cloudbot-codex-images-'));

        const images = writeCodexTurnImages(home, []);

        expect(images.paths)
            .toEqual([]);
        expect(readdirSync(home))
            .toEqual([]);
    });

    it('removes what it wrote when a later image fails', () => {
        const home = mkdtempSync(join(tmpdir(), 'cloudbot-codex-images-'));
        // A getter that throws stands in for a write that fails part way, such as on a full disk.
        const failing = { mediaType: 'image/png', get data(): string {
            throw new Error('disk full');
        } } as unknown as TurnImage;

        expect(() => writeCodexTurnImages(home, [{ mediaType: 'image/png', data: 'iVBORw0K' }, failing]))
            .toThrow('disk full');
        expect(readdirSync(home))
            .toEqual([]);
        expect(existsSync(home))
            .toBe(true);
    });
});
