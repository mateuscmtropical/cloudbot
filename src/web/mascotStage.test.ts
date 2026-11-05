// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { playTrick } from './mascotStage.ts';
import type { MascotTrick } from './mascotStage.ts';

function setReducedMotion(isReduced: boolean): void {
    window.matchMedia = vi.fn(() => ({ matches: isReduced })) as unknown as typeof window.matchMedia;
}

function addMascot(): HTMLElement {
    const pill = document.createElement('div');
    const mascot = document.createElement('span');

    pill.className = 'bot-pill';
    mascot.className = 'cloud-mascot';
    mascot.getBoundingClientRect = () => ({ left: 10, top: 10, right: 38, bottom: 38, width: 28, height: 28, x: 10, y: 10, toJSON: () => ({}) });
    pill.append(mascot);
    document.body.append(pill);

    return mascot;
}

describe('playTrick', () => {
    beforeEach(() => {
        setReducedMotion(false);
    });

    afterEach(() => {
        document.body.replaceChildren();
    });

    it('hides the mascot while the trick plays and gives it back at the end', async () => {
        const mascot = addMascot();
        let finishTrick = (): void => undefined;
        const trick: MascotTrick = () => new Promise((resolve) => {
            finishTrick = resolve;
        });
        const play = playTrick(trick);

        expect(mascot.hasAttribute('data-trick-away'))
            .toBe(true);
        expect(document.querySelector('.mascot-trick-copy')).not.toBeNull();

        finishTrick();
        await play?.finished;

        expect(mascot.hasAttribute('data-trick-away'))
            .toBe(false);
        expect(document.querySelector('.mascot-trick-layer'))
            .toBeNull();
    });

    it('stops at once on cancel, and a trick still waiting goes no further', async () => {
        const mascot = addMascot();
        const cancelAnimation = vi.fn();
        const animate = vi.fn(() => ({ cancel: cancelAnimation }));
        const reached = vi.fn();
        const trick: MascotTrick = async (stage) => {
            stage.copy.animate = animate as unknown as typeof stage.copy.animate;
            await stage.move(stage.copy, [], { duration: 100 });
            reached();
        };
        const play = playTrick(trick);

        play?.cancel();
        await play?.finished;

        expect(cancelAnimation)
            .toHaveBeenCalled();
        expect(reached).not.toHaveBeenCalled();
        expect(mascot.hasAttribute('data-trick-away'))
            .toBe(false);
    });

    it('gives the mascot back when a trick fails', async () => {
        const mascot = addMascot();
        const errorLog = vi.spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const play = playTrick(() => Promise.reject(new Error('broken')));

        await play?.finished;

        expect(mascot.hasAttribute('data-trick-away'))
            .toBe(false);
        errorLog.mockRestore();
    });

    it('does not play with reduced motion or without a mascot', () => {
        const trick: MascotTrick = () => Promise.resolve();

        expect(playTrick(trick))
            .toBeUndefined();

        addMascot();
        setReducedMotion(true);

        expect(playTrick(trick))
            .toBeUndefined();
    });
});
