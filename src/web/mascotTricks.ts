import type { Point } from './mascotPointer.ts';
import type { MascotTrick } from './mascotStage.ts';
import { MOVE_TRICKS } from './mascotTricksMove.ts';
import { VISIT_TRICKS } from './mascotTricksVisit.ts';
import { WEATHER_TRICKS } from './mascotTricksWeather.ts';

// A trick and what it needs in order to make sense.
interface TrickEntry {
    run: MascotTrick;
    needsOthers?: boolean;
    needsPointer?: boolean;
}

interface TrickWorld {
    otherCount: number;
    pointer: Point | undefined;
}

const MIN_PAUSE_MS = 45_000;
const MAX_PAUSE_MS = 120_000;
const ALL_TRICKS: Record<string, TrickEntry> = { ...MOVE_TRICKS, ...WEATHER_TRICKS, ...VISIT_TRICKS };

function canPlay(entry: TrickEntry, world: TrickWorld): boolean {
    return !(entry.needsOthers === true && world.otherCount === 0) && !(entry.needsPointer === true && world.pointer === undefined);
}

// A random trick that fits, other than the one just played.
function pickTrickName(tricks: Record<string, TrickEntry>, world: TrickWorld, lastName: string | undefined, randomValue: number): string | undefined {
    const names = Object.keys(tricks);
    const fitting = names.filter(name => name !== lastName && canPlay(tricks[name] as TrickEntry, world));

    return fitting[Math.floor(randomValue * fitting.length)];
}

function pickPauseMs(randomValue: number): number {
    return MIN_PAUSE_MS + randomValue * (MAX_PAUSE_MS - MIN_PAUSE_MS);
}

export { ALL_TRICKS, pickPauseMs, pickTrickName };
export type { TrickEntry, TrickWorld };
