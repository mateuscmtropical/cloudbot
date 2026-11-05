import { describe, expect, it } from 'vitest';

import type { TrickStage } from './mascotStage.ts';
import { MOVE_TRICKS } from './mascotTricksMove.ts';

interface FakeStage {
    stage: TrickStage;
    copyFrames: Keyframe[];
}

const HOME = { left: 150, right: 178, top: 18, bottom: 46, width: 28, height: 28 } as DOMRect;
const PHONE_MAIN = { left: 0, right: 360, top: 0, bottom: 640, width: 360, height: 640 } as DOMRect;

function makeFakeStage(): FakeStage {
    const copy = {} as HTMLElement;
    const copyFrames: Keyframe[] = [];
    const stage: TrickStage = {
        copy,
        home: HOME,
        main: PHONE_MAIN,
        others: [],
        pointer: undefined,
        move: (element, keyframes) => {
            if (element === copy) {
                copyFrames.push(...keyframes);
            }

            return Promise.resolve();
        },
        pause: () => Promise.resolve(),
        spawn: () => ({}) as SVGSVGElement,
        spawnThread: () => ({}) as HTMLElement,
    };

    return { stage, copyFrames };
}

describe('MOVE_TRICKS', () => {
    it.each(Object.keys(MOVE_TRICKS))('%s ends at home with no offset', async (name) => {
        const { stage, copyFrames } = makeFakeStage();
        const entry = MOVE_TRICKS[name];

        await entry?.run(stage);

        expect(copyFrames.at(-1))
            .toEqual({ transform: 'translate(0px, 0px) scale(1, 1) rotate(0deg)', opacity: 1 });
    });
});
