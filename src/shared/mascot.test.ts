import { describe, expect, it } from 'vitest';

import { MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_EYES, MASCOT_FACE_COLORS, MASCOT_PRESETS, MASCOT_SHAPES, readMascotColor, readMascotEyes, randomMascot } from './mascot.ts';

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

// The lowest contrast the vivid colors keep for a white face. The pastel colors follow the mascot sheet instead.
const MIN_FACE_CONTRAST = 3;
const VIVID_COLOR_COUNT = 9;

describe('mascot palette', () => {
    it('keeps at least 3 to 1 contrast between a white face and every vivid color', () => {
        const vividNames = MASCOT_COLOR_NAMES.slice(0, VIVID_COLOR_COUNT);

        vividNames.forEach((name) => {
            expect(whiteContrast(MASCOT_COLORS[name]))
                .toBeGreaterThanOrEqual(MIN_FACE_CONTRAST);
        });
    });

    it('gives a white body a face that is not white', () => {
        expect(MASCOT_FACE_COLORS.white)
            .not.toBe(MASCOT_COLORS.white);
    });

    it('has a ready look for each of the twelve clouds of the mascot sheet, made of known parts', () => {
        expect(MASCOT_PRESETS)
            .toHaveLength(12);
        MASCOT_PRESETS.forEach((preset) => {
            expect(MASCOT_COLOR_NAMES)
                .toContain(preset.color);
            expect(MASCOT_SHAPES)
                .toContain(preset.shape);
            expect(MASCOT_EYES)
                .toContain(preset.eyes);
        });
    });

    it('has no yellow, which reads as brown', () => {
        expect(MASCOT_COLOR_NAMES)
            .not.toContain('yellow');
        expect(Object.keys(MASCOT_COLORS))
            .not.toContain('yellow');
    });
});

describe('readMascotColor', () => {
    it('keeps a color that is in the palette', () => {
        expect(readMascotColor('orange'))
            .toBe('orange');
    });

    it('reads a stored color that is not in the palette as blue', () => {
        expect(readMascotColor('yellow'))
            .toBe('blue');
        expect(readMascotColor(''))
            .toBe('blue');
    });
});

describe('readMascotEyes', () => {
    it('keeps known eyes and reads unknown eyes as the smile', () => {
        expect(readMascotEyes('hearts'))
            .toBe('hearts');
        expect(readMascotEyes('lasers'))
            .toBe('smile');
    });
});

describe('randomMascot', () => {
    it('takes the first look of the sheet for a random source that returns 0', () => {
        expect(randomMascot(() => 0))
            .toEqual({ color: 'white', shape: 'puff', eyes: 'cross' });
    });

    it('takes the last look of the sheet for a random source that returns almost 1', () => {
        expect(randomMascot(() => 0.999))
            .toEqual({ color: 'iris', shape: 'bubble', eyes: 'happy' });
    });
});
