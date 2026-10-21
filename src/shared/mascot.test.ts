import { describe, expect, it } from 'vitest';

import { MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_SHAPES, randomMascot } from './mascot.ts';

// The relative luminance of a color, from its hex text, as WCAG defines it.
function relativeLuminance(hex: string): number {
    const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const linear = channels.map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

    return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

// The contrast ratio of a white face on a color, from 1 to 21. See MIN_FACE_CONTRAST for the lowest value the palette keeps.
function whiteContrast(hex: string): number {
    const colorLuminance = relativeLuminance(hex);

    return 1.05 / (colorLuminance + 0.05);
}

// The lowest contrast the palette keeps for a white face.
const MIN_FACE_CONTRAST = 3;

describe('mascot palette', () => {
    it('keeps at least 3 to 1 contrast between a white face and every color', () => {
        MASCOT_COLOR_NAMES.forEach((name) => {
            expect(whiteContrast(MASCOT_COLORS[name]))
                .toBeGreaterThanOrEqual(MIN_FACE_CONTRAST);
        });
    });

    it('has about ten colors and four shapes', () => {
        expect(MASCOT_COLOR_NAMES)
            .toHaveLength(10);
        expect(MASCOT_SHAPES)
            .toHaveLength(4);
    });
});

describe('randomMascot', () => {
    it('takes the first color and shape for a random source that returns 0', () => {
        expect(randomMascot(() => 0))
            .toEqual({ color: 'blue', shape: 'puff' });
    });

    it('takes the last color and shape for a random source that returns almost 1', () => {
        expect(randomMascot(() => 0.999))
            .toEqual({ color: 'green', shape: 'bubble' });
    });
});
