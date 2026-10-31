// The mascot of a bot: a cloud body in one of these colors, drawn in one of these shapes, with one of these pairs of eyes.
// The eyes are the face the bot shows while it rests. A bot at work still shows the face of what it does, such as thinking.
// The first nine colors are vivid, so the white face reaches at least 3 to 1 on each. The other colors follow the mascot
// sheet of the project, pastel shades included. White has blue eyes, and the others keep white eyes like the sheet.
// The old dark yellow read as brown and is gone. The pastel "sun" is the yellow of the sheet.
const MASCOT_COLOR_NAMES = [
    'blue', 'mint', 'purple', 'orange', 'cyan', 'pink', 'violet', 'red', 'green',
    'white', 'azure', 'teal', 'lavender', 'navy', 'slate', 'rose', 'sun', 'tangerine', 'sky', 'blush', 'iris',
] as const;

const MASCOT_SHAPES = ['puff', 'tall', 'wide', 'bubble', 'bubbles', 'curl', 'wisp'] as const;

const MASCOT_EYES = ['smile', 'cross', 'arch', 'dots', 'wink', 'hearts', 'stars', 'excited', 'sleepy', 'peek', 'happy'] as const;

type MascotColorName = (typeof MASCOT_COLOR_NAMES)[number];
type MascotShape = (typeof MASCOT_SHAPES)[number];
type MascotEyes = (typeof MASCOT_EYES)[number];

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
    white: '#ffffff',
    azure: '#0a95ff',
    teal: '#2fd3b5',
    lavender: '#968cfa',
    navy: '#1f3570',
    slate: '#a9b8d1',
    rose: '#fdb7bd',
    sun: '#fecd5a',
    tangerine: '#ff8c38',
    sky: '#93d1fd',
    blush: '#fdb9cd',
    iris: '#8a6ff5',
};

// The eyes are white, except on a white body.
const MASCOT_FACE_COLORS: Partial<Record<MascotColorName, string>> = {
    white: '#1a8cff',
};

interface MascotChoice {
    color: MascotColorName;
    shape: MascotShape;
    eyes: MascotEyes;
}

interface MascotPreset extends MascotChoice {
    // The name the owner sees, from the mascot sheet.
    label: string;
}

// The twelve clouds of the mascot sheet. Each one is a full look the owner can pick at once.
const MASCOT_PRESETS: MascotPreset[] = [
    { label: 'X eyes', color: 'white', shape: 'puff', eyes: 'cross' },
    { label: 'Smiling', color: 'azure', shape: 'puff', eyes: 'smile' },
    { label: 'Smiling U', color: 'teal', shape: 'bubble', eyes: 'arch' },
    { label: 'Arcs', color: 'lavender', shape: 'curl', eyes: 'smile' },
    { label: 'Dots', color: 'navy', shape: 'puff', eyes: 'dots' },
    { label: 'Wink', color: 'slate', shape: 'wisp', eyes: 'wink' },
    { label: 'Hearts', color: 'rose', shape: 'puff', eyes: 'hearts' },
    { label: 'Stars', color: 'sun', shape: 'puff', eyes: 'stars' },
    { label: 'Excited', color: 'tangerine', shape: 'puff', eyes: 'excited' },
    { label: 'Sleepy', color: 'sky', shape: 'bubbles', eyes: 'sleepy' },
    { label: 'Peek', color: 'blush', shape: 'puff', eyes: 'peek' },
    { label: 'Happy', color: 'iris', shape: 'bubble', eyes: 'happy' },
];

// A random number source in [0, 1). Tests pass a fixed one.
type RandomSource = () => number;

function pickOne<Item>(items: readonly Item[], random: RandomSource): Item {
    const index = Math.floor(random() * items.length);

    return items[index] ?? items[0] as Item;
}

// The look of a new bot: one of the clouds of the mascot sheet, each equally likely.
function randomMascot(random: RandomSource = Math.random): MascotChoice {
    const preset = pickOne(MASCOT_PRESETS, random);

    return { color: preset.color, shape: preset.shape, eyes: preset.eyes };
}

const FALLBACK_MASCOT_COLOR: MascotColorName = 'blue';
const FALLBACK_MASCOT_SHAPE: MascotShape = 'puff';
const FALLBACK_MASCOT_EYES: MascotEyes = 'smile';

function readKnownName<Name extends string>(known: readonly Name[], stored: string, fallback: Name): Name {
    const knownNames: readonly string[] = known;

    return knownNames.includes(stored) ? stored as Name : fallback;
}

// A stored color that is not in the palette, such as a color removed later, reads as blue. The bot still shows up.
function readMascotColor(storedColor: string): MascotColorName {
    return readKnownName(MASCOT_COLOR_NAMES, storedColor, FALLBACK_MASCOT_COLOR);
}

function readMascotShape(storedShape: string): MascotShape {
    return readKnownName(MASCOT_SHAPES, storedShape, FALLBACK_MASCOT_SHAPE);
}

function readMascotEyes(storedEyes: string): MascotEyes {
    return readKnownName(MASCOT_EYES, storedEyes, FALLBACK_MASCOT_EYES);
}

export {
    MASCOT_COLORS,
    MASCOT_COLOR_NAMES,
    MASCOT_EYES,
    MASCOT_FACE_COLORS,
    MASCOT_PRESETS,
    MASCOT_SHAPES,
    randomMascot,
    readMascotColor,
    readMascotEyes,
    readMascotShape,
};
export type { MascotChoice, MascotColorName, MascotEyes, MascotPreset, MascotShape, RandomSource };
