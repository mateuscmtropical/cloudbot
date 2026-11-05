import { describe, expect, it } from 'vitest';

import { ALL_TRICKS, pickPauseMs, pickTrickName } from './mascotTricks.ts';
import type { TrickEntry } from './mascotTricks.ts';

const ANY_RUN: TrickEntry['run'] = () => Promise.resolve();
const TRICKS: Record<string, TrickEntry> = {
    plain: { run: ANY_RUN },
    visit: { run: ANY_RUN, needsOthers: true },
    greet: { run: ANY_RUN, needsPointer: true },
};
const POINTER = { x: 1, y: 1 };

describe('pickTrickName', () => {
    it('leaves out a trick the page cannot play', () => {
        expect(pickTrickName(TRICKS, { otherCount: 0, pointer: undefined }, undefined, 0.99))
            .toBe('plain');
    });

    it('can pick each trick that fits', () => {
        const world = { otherCount: 2, pointer: POINTER };

        expect(pickTrickName(TRICKS, world, undefined, 0))
            .toBe('plain');
        expect(pickTrickName(TRICKS, world, undefined, 0.5))
            .toBe('visit');
        expect(pickTrickName(TRICKS, world, undefined, 0.99))
            .toBe('greet');
    });

    it('does not repeat the last trick', () => {
        expect(pickTrickName(TRICKS, { otherCount: 2, pointer: POINTER }, 'plain', 0))
            .toBe('visit');
    });

    it('answers nothing when no trick fits', () => {
        expect(pickTrickName(TRICKS, { otherCount: 0, pointer: undefined }, 'plain', 0))
            .toBeUndefined();
    });
});

describe('pickPauseMs', () => {
    it('stays between the shortest and the longest pause', () => {
        expect(pickPauseMs(0))
            .toBe(45_000);
        expect(pickPauseMs(1))
            .toBe(120_000);
    });
});

describe('ALL_TRICKS', () => {
    it('holds what the owner asked for', () => {
        const names = Object.keys(ALL_TRICKS);

        expect(names)
            .toEqual(expect.arrayContaining(['hang', 'fly', 'dance', 'sneezeRain', 'sneezeSnow', 'sneezeBolt', 'boop']));
    });
});
