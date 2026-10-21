import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The reduced motion rule lives in the stylesheet, so the test reads the file itself.
const STYLESHEET_PATH = new URL('../web/styles.css', import.meta.url);

describe('mascot reduced motion in the stylesheet', () => {
    it('turns off every mascot animation, the squish and the eye movement under prefers-reduced-motion', () => {
        const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');
        const reducedBlockStart = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)');
        const reducedBlock = stylesheet.slice(reducedBlockStart);

        expect(reducedBlockStart)
            .toBeGreaterThanOrEqual(0);
        expect(reducedBlock)
            .toContain('.cloud-mascot svg');
        expect(reducedBlock)
            .toContain('.cloud-mascot .cloud-blink');
        expect(reducedBlock)
            .toContain('.cloud-mascot .cloud-face > g');
        expect(reducedBlock)
            .toContain('animation: none !important');
    });
});
