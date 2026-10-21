// The mascot of a bot: a cloud body in one of these vivid colors, drawn in one of these shapes. The white face is drawn
// on top, so any color can show any face. Some colors are darker than their brand shade, so the white face reaches at least 3 to 1 on each.
const MASCOT_COLOR_NAMES = ['blue', 'mint', 'purple', 'yellow', 'orange', 'cyan', 'pink', 'violet', 'red', 'green'] as const;

const MASCOT_SHAPES = ['puff', 'tall', 'wide', 'bubble'] as const;

type MascotColorName = (typeof MASCOT_COLOR_NAMES)[number];
type MascotShape = (typeof MASCOT_SHAPES)[number];

const MASCOT_COLORS: Record<MascotColorName, string> = {
    blue: '#1a7cff',
    mint: '#00a37a',
    purple: '#7a4dff',
    yellow: '#c98200',
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

export { MASCOT_COLORS, MASCOT_COLOR_NAMES, MASCOT_SHAPES, randomMascot };
export type { MascotChoice, MascotColorName, MascotShape, RandomSource };
