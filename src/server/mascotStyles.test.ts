import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// The reduced motion rule lives in the stylesheet, so the test reads the file itself.
const STYLESHEET_PATH = new URL('../web/styles.css', import.meta.url);

describe('mascot reduced motion in the stylesheet', () => {
    it('turns off the body animations, and only the easing of the eyes, under prefers-reduced-motion', () => {
        const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');
        const reducedBlockStart = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)');
        const reducedBlockEnd = stylesheet.indexOf('.unread-dot', reducedBlockStart);
        const reducedBlock = stylesheet.slice(reducedBlockStart, reducedBlockEnd);

        expect(reducedBlockStart)
            .toBeGreaterThanOrEqual(0);
        expect(reducedBlock)
            .toContain('.cloud-mascot svg');
        expect(reducedBlock)
            .toContain('animation: none !important');
        expect(reducedBlock)
            .toContain('transition: none !important');
    });

    it('keeps the eye offset and the blink under prefers-reduced-motion', () => {
        const stylesheet = readFileSync(STYLESHEET_PATH, 'utf8');
        const reducedBlockStart = stylesheet.indexOf('@media (prefers-reduced-motion: reduce)');
        const reducedBlockEnd = stylesheet.indexOf('.unread-dot', reducedBlockStart);
        const reducedBlock = stylesheet.slice(reducedBlockStart, reducedBlockEnd);

        expect(reducedBlock)
            .not.toMatch(/cloud-face > g\s*\{[^}]*transform/);
        expect(reducedBlock)
            .not.toMatch(/cloud-eyes[^{]*\{[^}]*transform/);
    });
});
