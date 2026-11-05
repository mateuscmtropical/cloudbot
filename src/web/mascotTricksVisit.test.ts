// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import type { TrickStage } from './mascotStage.ts';
import { VISIT_TRICKS } from './mascotTricksVisit.ts';

interface RecordedMove {
    element: Element;
    keyframes: Keyframe[];
}

interface FakeStage {
    stage: TrickStage;
    moves: RecordedMove[];
    readBackboneMs: () => number;
}

const AT_REST = 'translate(0px, 0px) scale(1) rotate(0deg)';
const COPY_RECT = { left: 500, top: 10, right: 528, bottom: 38, width: 28, height: 28 } as DOMRect;
const MAIN_RECT = { left: 320, top: 0, right: 1300, bottom: 800, width: 980, height: 800 } as DOMRect;

function makeOther(index: number): HTMLElement {
    const element = document.createElement('div');
    const top = 100 + index * 77;
    const rect = { left: 16, top, right: 60, bottom: top + 44, width: 44, height: 44 } as DOMRect;

    element.getBoundingClientRect = () => rect;

    return element;
}

function makeFakeStage(otherCount: number): FakeStage {
    const moves: RecordedMove[] = [];
    const copy = document.createElement('div');
    const others = Array.from({ length: otherCount }, (_unused, index) => makeOther(index));
    let backboneMs = 0;

    const stage: TrickStage = {
        copy,
        home: COPY_RECT,
        main: MAIN_RECT,
        others,
        pointer: undefined,
        move: (element, keyframes, options) => {
            moves.push({ element, keyframes });
            backboneMs += element === copy ? Number(options.duration) : 0;

            return Promise.resolve();
        },
        pause: (durationMs) => {
            backboneMs += durationMs;

            return Promise.resolve();
        },
        spawn: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        spawnThread: () => document.createElement('div'),
    };

    return { stage, moves, readBackboneMs: () => backboneMs };
}

function readLastTransform(moves: RecordedMove[], element: Element): unknown {
    const lastMove = moves.filter(move => move.element === element)
        .at(-1);
    const lastFrame = lastMove?.keyframes.at(-1);

    return lastFrame?.transform;
}

describe('VISIT_TRICKS', () => {
    const cases = Object.entries(VISIT_TRICKS)
        .flatMap(([name, entry]) => [1, 3, 20].map(otherCount => ({ name, entry, otherCount })));

    it.each(cases)('$name with $otherCount others ends with everything at rest, in time', async ({ entry, otherCount }) => {
        const { stage, moves, readBackboneMs } = makeFakeStage(otherCount);

        await entry.run(stage);

        expect(readLastTransform(moves, stage.copy))
            .toBe(AT_REST);
        stage.others.forEach((other) => {
            const lastTransform = readLastTransform(moves, other);

            expect([undefined, AT_REST])
                .toContain(lastTransform);
        });
        // This counts only the copy, so the replies of the other bots add a little more on screen.
        expect(readBackboneMs())
            .toBeGreaterThanOrEqual(2500);
        expect(readBackboneMs())
            .toBeLessThan(12_000);
    });

    it('does nothing when no other bot is on screen', async () => {
        const entries = Object.values(VISIT_TRICKS);
        const { stage, moves } = makeFakeStage(0);
        const runs = entries.map(entry => entry.run(stage));

        await Promise.all(runs);

        expect(moves)
            .toEqual([]);
    });
});
