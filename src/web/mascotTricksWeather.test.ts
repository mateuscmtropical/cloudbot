import { describe, expect, it } from 'vitest';

import type { TrickStage } from './mascotStage.ts';
import { WEATHER_TRICKS } from './mascotTricksWeather.ts';

const HOME_TRANSFORM = 'translate(0px, 0px) scale(1, 1) rotate(0deg)';
const COPY = {} as HTMLElement;
const HOME_RECT = { left: 100, top: 10, right: 128, bottom: 38, width: 28, height: 28 } as DOMRect;
const MAIN_RECT = { left: 0, top: 0, right: 400, bottom: 800, width: 400, height: 800 } as DOMRect;

describe('WEATHER_TRICKS', () => {
    it.each(Object.keys(WEATHER_TRICKS))('%s ends with the copy at home', async (name) => {
        const copyKeyframes: Keyframe[][] = [];
        const stage: TrickStage = {
            copy: COPY,
            home: HOME_RECT,
            main: MAIN_RECT,
            others: [],
            pointer: { x: 300, y: 500 },
            move: (element, keyframes) => {
                if (element === COPY) {
                    copyKeyframes.push(keyframes);
                }

                return Promise.resolve();
            },
            pause: () => Promise.resolve(),
            spawn: () => ({}) as SVGSVGElement,
            spawnThread: () => ({}) as HTMLElement,
        };

        await WEATHER_TRICKS[name]?.run(stage);

        const lastMove = copyKeyframes.at(-1);
        const lastKeyframe = lastMove?.at(-1);

        expect(lastKeyframe?.transform)
            .toBe(HOME_TRANSFORM);
    });
});
