import { describe, expect, it } from 'vitest';

import { pickMascotEffect, pickMascotMood, readSneezeDelaySeconds } from './mascotMood.ts';

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_000 * 24 * HOUR_MS;

describe('pickMascotMood', () => {
    it('puts a quiet bot to sleep, unless it is the open one', () => {
        const quiet = { botId: 'b', lastActivityAt: NOW - 2 * HOUR_MS, now: NOW };

        expect(pickMascotMood({ ...quiet, isSelected: false }))
            .toBe('sleeping');
        expect(pickMascotMood({ ...quiet, isSelected: true })).not.toBe('sleeping');
    });

    it('treats a bot with no activity as quiet', () => {
        expect(pickMascotMood({ botId: 'b', lastActivityAt: undefined, isSelected: false, now: NOW }))
            .toBe('sleeping');
    });

    it('keeps a recent bot awake', () => {
        expect(pickMascotMood({ botId: 'b', lastActivityAt: NOW - 1000, isSelected: false, now: NOW })).not.toBe('sleeping');
    });

    it('gives a bot a cold on some days and not on others, the same all day', () => {
        const moods = Array.from({ length: 5 }, (_value, day) => pickMascotMood({ botId: 'b', lastActivityAt: NOW, isSelected: true, now: NOW + day * 24 * HOUR_MS }));
        const laterToday = pickMascotMood({ botId: 'b', lastActivityAt: NOW, isSelected: true, now: NOW + HOUR_MS });

        expect(moods.filter(mood => mood === 'cold'))
            .toHaveLength(1);
        expect(laterToday)
            .toBe(moods[0]);
    });
});

describe('pickMascotEffect', () => {
    it('lets a real state win over the mood', () => {
        expect(pickMascotEffect('error', 'sleeping'))
            .toBe('storm');
        expect(pickMascotEffect('waiting', 'cold'))
            .toBe('question');
        expect(pickMascotEffect('done', 'cold'))
            .toBe('cheer');
        expect(pickMascotEffect('sleepy', undefined))
            .toBe('sleeping');
        expect(pickMascotEffect('thinking', 'cold'))
            .toBeUndefined();
    });

    it('shows the mood only while idle', () => {
        expect(pickMascotEffect('idle', 'cold'))
            .toBe('cold');
        expect(pickMascotEffect('idle', undefined))
            .toBeUndefined();
    });
});

describe('readSneezeDelaySeconds', () => {
    it('stays inside one sneeze cycle', () => {
        const delay = readSneezeDelaySeconds('some-bot-id');

        expect(delay)
            .toBeLessThanOrEqual(0);
        expect(delay)
            .toBeGreaterThan(-14);
    });
});
