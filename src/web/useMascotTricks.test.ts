// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { playTrick } from './mascotStage.ts';
import type { TrickPlay } from './mascotStage.ts';
import { useMascotTricks } from './useMascotTricks.ts';

vi.mock('./mascotStage.ts', () => ({
    findOtherMascots: () => [],
    playTrick: vi.fn(),
}));

const LONGEST_PAUSE_MS = 120_000;

function makePlay(): TrickPlay & { end: () => void } {
    let end = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
        end = resolve;
    });

    return { cancel: vi.fn(() => { end(); }), finished, end };
}

describe('useMascotTricks', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(playTrick)
            .mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('plays nothing while the bot works', () => {
        renderHook(() => {
            useMascotTricks(false, 'bot-1');
        });
        vi.advanceTimersByTime(LONGEST_PAUSE_MS);

        expect(playTrick).not.toHaveBeenCalled();
    });

    it('plays after a pause, and waits for the trick before the next pause', async () => {
        const play = makePlay();

        vi.mocked(playTrick)
            .mockReturnValue(play);
        renderHook(() => {
            useMascotTricks(true, 'bot-1');
        });
        vi.advanceTimersByTime(LONGEST_PAUSE_MS);

        expect(playTrick)
            .toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(LONGEST_PAUSE_MS);

        expect(playTrick)
            .toHaveBeenCalledTimes(1);

        play.end();
        await vi.advanceTimersByTimeAsync(LONGEST_PAUSE_MS);

        expect(playTrick)
            .toHaveBeenCalledTimes(2);
    });

    it('ends the trick when the chat changes, and the old chat plays nothing more', async () => {
        const play = makePlay();

        vi.mocked(playTrick)
            .mockReturnValueOnce(play);

        const view = renderHook(() => {
            useMascotTricks(true, 'bot-1');
        });

        vi.advanceTimersByTime(LONGEST_PAUSE_MS);
        view.unmount();

        expect(play.cancel)
            .toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(LONGEST_PAUSE_MS * 2);

        expect(playTrick)
            .toHaveBeenCalledTimes(1);
    });
});
