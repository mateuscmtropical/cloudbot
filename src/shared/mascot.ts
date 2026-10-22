// The mascot of a bot: a cloud body in one of these vivid colors, drawn in one of these shapes. The white face is drawn
// on top, so any color can show any face. Some colors are darker than their brand shade, so the white face reaches at least 3 to 1 on each.
// Yellow is not here: its dark shade reads as brown, so a bot that had it was moved to orange by a migration.
const MASCOT_COLOR_NAMES = ['blue', 'mint', 'purple', 'orange', 'cyan', 'pink', 'violet', 'red', 'green'] as const;

const MASCOT_SHAPES = ['puff', 'tall', 'wide', 'bubble'] as const;

type MascotColorName = (typeof MASCOT_COLOR_NAMES)[number];
type MascotShape = (typeof MASCOT_SHAPES)[number];

const MASCOT_COLORS: Record<MascotColorName, string> = {
    blue: '#1a7cff',
    mint: '#00a37a',
    purple: '#7a4dff',
    orange: '#e35d00',
    cyan: '#0090bd',
    pink: '#ff2e8a',
    violet: '#b03dff',
    red: '#ff3b3b',
    green: '#22a33a',
};

interface MascotChoice {
    color: MascotColorName;
    shape: MascotShape;
}

// A random number source in [0, 1). Tests pass a fixed one.
type RandomSource = () => number;

function pickOne<Item>(items: readonly Item[], random: RandomSource): Item {
    const index = Math.floor(random() * items.length);

    return items[index] ?? items[0] as Item;
}

// The look of a new bot. Any color and any shape are equally likely.
function randomMascot(random: RandomSource = Math.random): MascotChoice {
    const color = pickOne(MASCOT_COLOR_NAMES, random);
    const shape = pickOne(MASCOT_SHAPES, random);

    return { color, shape };
}

const FALLBACK_MASCOT_COLOR: MascotColorName = 'blue';

// A stored color that is not in the palette, such as a color removed later, reads as blue. The bot still shows up.
function readMascotColor(storedColor: string): MascotColorName {
    const knownNames: readonly string[] = MASCOT_COLOR_NAMES;

    return knownNames.includes(storedColor) ? storedColor as MascotColorName : FALLBACK_MASCOT_COLOR;
}

export { MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_SHAPES, readMascotColor, randomMascot };
export type { MascotChoice, MascotColorName, MascotShape, RandomSource };
