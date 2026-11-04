import { describe, expect, it } from 'vitest';

import { pickMascotEffect, pickMascotMood, readNextMoodChangeAt, readSneezeDelaySeconds } from './mascotMood.ts';

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

describe('falling asleep after leaving a chat', () => {
    const HOUR_MS = 60 * 60 * 1000;
    // A bot id and a day with no cold, so only the sleep shows.
    const quietChat = (now: number, leftAt: number): Parameters<typeof pickMascotMood>[0] => ({ botId: 'a', lastActivityAt: now - 5 * HOUR_MS, isSelected: false, now, leftAt });

    it('stays awake, then nods, then sleeps', () => {
        const leftAt = 1000 * HOUR_MS;
        const moods = [leftAt, leftAt + 54_000, leftAt + 55_000, leftAt + 59_999, leftAt + 60_000].map(now => pickMascotMood(quietChat(now, leftAt)));

        expect(moods[0])
            .not.toBe('sleeping');
        expect(moods[1])
            .not.toBe('dozing');
        expect(moods.slice(2))
            .toEqual(['dozing', 'dozing', 'sleeping']);
    });

    it('is asleep at once when the chat was not just left', () => {
        const now = 1000 * HOUR_MS;

        expect(pickMascotMood({ botId: 'a', lastActivityAt: now - 2 * HOUR_MS, isSelected: false, now }))
            .toBe('sleeping');
    });

    it('wakes the timer at each step and then only for the next day', () => {
        const leftAt = 1000 * HOUR_MS;

        expect(readNextMoodChangeAt(quietChat(leftAt, leftAt)))
            .toBe(leftAt + 55_000);
        expect(readNextMoodChangeAt(quietChat(leftAt + 55_000, leftAt)))
            .toBe(leftAt + 60_000);
        expect(readNextMoodChangeAt(quietChat(leftAt + 60_000, leftAt)) % (24 * HOUR_MS))
            .toBe(0);
    });
});
