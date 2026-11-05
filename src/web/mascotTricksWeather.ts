import type { Point } from './mascotPointer.ts';
import type { TrickPieceKind, TrickStage } from './mascotStage.ts';
import type { TrickEntry } from './mascotTricks.ts';

// A small drawing that floats up from a point and fades.
interface FloatingPiece {
    kind: TrickPieceKind;
    center: Point;
    size: number;
    rise: number;
    delay: number;
}

// One lump of the puff the mascot hides behind, placed and sized in mascot widths.
interface PuffLump {
    x: number;
    y: number;
    size: number;
}

type WeatherRelease = (stage: TrickStage) => Promise<void>;

const FULL_TURN = Math.PI * 2;
const HOME = pose(0, 0);

// The weather stays faint so that the chat can still be read.
const RAIN_COUNT = 22;
const RAIN_STAGGER_MS = 110;
const RAIN_OPACITY = 0.55;
// The drawn drop leans by this much, so it falls along its own line.
const RAIN_SLANT = -2 / 12;
const RAIN_MS = 3_750;
const FLAKE_COUNT = 26;
const FLAKE_STAGGER_MS = 50;
const FLAKE_OPACITY = 0.65;
const SNOW_MS = 3_750;
const BOLT_COUNT = 5;
const BOLT_STAGGER_MS = 600;
const BOLT_FLASH_MS = 420;
const BOLT_FLICKER = [0, 0.7, 0.1, 0.7, 0.25, 0.65, 0];

// The sneeze. The two breaths go up and back, and the jolt goes down and forward.
const FIRST_BREATH = pose(-1, -2, 1.1, 1.14, -6);
const BREATH_OUT = pose(0, -1, 1.04, 1.06, -3);
const SECOND_BREATH = pose(-3, -4, 1.26, 1.32, -13);
const BREATH_QUIVER = pose(-3.5, -4, 1.28, 1.34, -14);
const JOLT = pose(12, 8, 1.2, 0.72, 18);
const RECOIL = pose(-7, -4, 0.92, 1.08, -9);
const ACHOO_MS = 480;
const SHOCK_POSES = [HOME, pose(-3, -1, 1.06, 1.06, -5), pose(3, 1, 1.06, 1.06, 5), pose(-3, 1, 1.03, 1.03, -4), pose(3, -1, 1.03, 1.03, 4), HOME];
const SHY = pose(0, 2, 0.92, 0.92, -6);
const SHY_SHAKE = [SHY, pose(-1.5, 2, 0.92, 0.92, -8), pose(1.5, 2, 0.92, 0.92, -4), pose(-1, 2, 0.92, 0.92, -7), pose(1, 2, 0.92, 0.92, -5), SHY];

const DANCE_LAST_BEAT = pose(9, 0, 1.16, 0.82, 6);
const DANCE_BEATS = [pose(-7, -10, 0.94, 1.08, -12), pose(-9, 0, 1.16, 0.82, -6), pose(7, -10, 0.94, 1.08, 12), DANCE_LAST_BEAT];
const DANCE_POSE = pose(0, -5, 1.14, 1.14, -10);
const NOTE_COUNT = 8;

const SPIN_TURNS_DEG = 1_080;
const WOBBLE_MS = 2_400;
const WOBBLE_RADIUS = 5;
const WOBBLE_TURNS = 4;
const DAZED_STAR_COUNT = 5;
const DAZED_STAR_TURNS = 3;
const DAZED_STAR_TOP_MIN = 12;

const HEART_COUNT = 5;

const SNORE_COUNT = 3;
const WAKE_POSE = pose(0, -12, 0.86, 1.2, 8);

const JUGGLE_MS = 2_200;
const JUGGLE_TURNS = 3;
const JUGGLE_STAR_COUNT = 3;

const PUFF_LUMPS: PuffLump[] = [
    { x: 0, y: 0.08, size: 1.9 },
    { x: -0.45, y: 0.2, size: 1.45 },
    { x: 0.45, y: 0.2, size: 1.45 },
];
const TUCKED = pose(0, 3, 0.62, 0.62, 0);

function pose(offsetX: number, offsetY: number, scaleX = 1, scaleY = scaleX, turn = 0): string {
    return `translate(${String(offsetX)}px, ${String(offsetY)}px) scale(${String(scaleX)}, ${String(scaleY)}) rotate(${String(turn)}deg)`;
}

function pieceFrame(offsetX: number, offsetY: number, opacity: number, scale = 1, turn = 0): Keyframe {
    return { transform: pose(offsetX, offsetY, scale, scale, turn), opacity };
}

// Moves the mascot through some poses with the same pace between each pair.
function moveCopy(stage: TrickStage, poses: string[], durationMs: number, easing = 'ease-in-out'): Promise<void> {
    const keyframes = poses.map(transform => ({ transform, easing }));

    return stage.move(stage.copy, keyframes, { duration: durationMs });
}

function randomBetween(lowest: number, highest: number): number {
    return lowest + Math.random() * (highest - lowest);
}

function times(count: number, action: (index: number) => void): void {
    Array.from({ length: count })
        .forEach((_unused, index) => {
            action(index);
        });
}

// Evenly spaced steps from 0 to exactly 1, for a path drawn from many keyframes.
function sample<Result>(stepCount: number, atProgress: (progress: number) => Result): Result[] {
    return Array.from({ length: stepCount + 1 }, (_unused, index) => atProgress(index / stepCount));
}

function homeCenter(stage: TrickStage): Point {
    return {
        x: stage.home.left + stage.home.width / 2,
        y: stage.home.top + stage.home.height / 2,
    };
}

function clamp(value: number, lowest: number, highest: number): number {
    const raised = Math.max(value, lowest);

    return Math.min(raised, highest);
}

function clampToMain(stage: TrickStage, point: Point, margin: number): Point {
    const { main } = stage;

    return {
        x: clamp(point.x, main.left + margin, main.right - margin),
        y: clamp(point.y, main.top + margin, main.bottom - margin),
    };
}

function floatUp(stage: TrickStage, floating: FloatingPiece): void {
    const { kind, center, size, rise, delay } = floating;
    const piece = stage.spawn(kind, center, size);
    const drift = randomBetween(-10, 10);
    const keyframes = [
        pieceFrame(0, 0, 0, 0.6),
        pieceFrame(drift / 2, -rise / 2, 0.85, 1, drift),
        pieceFrame(drift, -rise, 0, 1.1, -drift),
    ];

    void stage.move(piece, keyframes, { duration: 1_200, delay, easing: 'ease-out' });
}

function burstStars(stage: TrickStage, center: Point): void {
    const reach = stage.home.width;

    times(5, (index) => {
        const piece = stage.spawn('star', center, 9);
        const angle = index / 5 * FULL_TURN;
        const outX = Math.cos(angle) * reach;
        const outY = Math.sin(angle) * reach;
        const keyframes = [pieceFrame(0, 0, 0.9, 0.4), pieceFrame(outX, outY, 0, 1, 120)];

        void stage.move(piece, keyframes, { duration: 520, easing: 'ease-out' });
    });
}

function fallRainDrop(stage: TrickStage, index: number): void {
    const { main } = stage;
    const size = randomBetween(14, 22);
    const startY = randomBetween(main.top, main.top + main.height * 0.25);
    const startX = randomBetween(main.left, main.right);
    const fall = main.bottom - startY + size;
    const slide = fall * RAIN_SLANT;
    const piece = stage.spawn('rain', { x: startX, y: startY }, size);
    const keyframes = [
        pieceFrame(0, 0, 0),
        pieceFrame(slide * 0.1, fall * 0.1, RAIN_OPACITY),
        pieceFrame(slide * 0.85, fall * 0.85, RAIN_OPACITY),
        pieceFrame(slide, fall, 0),
    ];
    const duration = randomBetween(900, 1_300);
    const delay = index * RAIN_STAGGER_MS + randomBetween(0, 120);

    void stage.move(piece, keyframes, { duration, delay, easing: 'linear' });
}

function pourRain(stage: TrickStage): Promise<void> {
    times(RAIN_COUNT, (index) => {
        fallRainDrop(stage, index);
    });

    return stage.pause(RAIN_MS);
}

function driftFlake(stage: TrickStage, index: number): void {
    const { main } = stage;
    const size = randomBetween(10, 16);
    const startY = randomBetween(main.top, main.top + main.height * 0.3);
    const startX = randomBetween(main.left, main.right);
    const fall = main.height * randomBetween(0.55, 0.9);
    const slide = Math.min(main.width * 0.5, fall * 0.4);
    const spin = randomBetween(180, 420);
    const piece = stage.spawn('flake', { x: startX, y: startY }, size);
    const keyframes = [
        pieceFrame(0, 0, 0, 1, 0),
        pieceFrame(slide * 0.15, fall * 0.15, FLAKE_OPACITY, 1, spin * 0.15),
        pieceFrame(slide * 0.85, fall * 0.85, FLAKE_OPACITY, 1, spin * 0.85),
        pieceFrame(slide, fall, 0, 1, spin),
    ];
    const duration = randomBetween(1_800, 2_400);

    void stage.move(piece, keyframes, { duration, delay: index * FLAKE_STAGGER_MS, easing: 'linear' });
}

function blowBlizzard(stage: TrickStage): Promise<void> {
    times(FLAKE_COUNT, (index) => {
        driftFlake(stage, index);
    });

    return stage.pause(SNOW_MS);
}

// One bolt flickers somewhere around the mascot, further away each time, and the mascot feels it.
function flashBolt(stage: TrickStage, index: number): Promise<void> {
    const { main } = stage;
    const center = homeCenter(stage);
    const size = randomBetween(28, 46);
    const shortSide = Math.min(main.width, main.height);
    const distance = (index + 1) / BOLT_COUNT * shortSide * 0.6;
    const angle = randomBetween(0.1, 0.9) * Math.PI;
    const place = clampToMain(stage, { x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance }, size / 2);
    const piece = stage.spawn('bolt', place, size);
    const turn = randomBetween(-18, 18);
    const keyframes = BOLT_FLICKER.map(opacity => pieceFrame(0, 0, opacity, 1, turn));
    const delay = ACHOO_MS + index * BOLT_STAGGER_MS;
    const shake = SHOCK_POSES.map(transform => ({ transform, easing: 'linear' }));

    void stage.move(piece, keyframes, { duration: BOLT_FLASH_MS, delay });

    return stage.move(stage.copy, shake, { duration: BOLT_FLASH_MS, delay });
}

async function strikeLightning(stage: TrickStage): Promise<void> {
    const flashes = Array.from({ length: BOLT_COUNT }, (_unused, index) => flashBolt(stage, index));

    await Promise.all(flashes);
}

// The shared sneeze. The jolt is one animation, so the shocks of the lightning, made after it, can play on top of it.
async function sneeze(stage: TrickStage, release: WeatherRelease): Promise<void> {
    await moveCopy(stage, [HOME, FIRST_BREATH], 520, 'ease-out');
    await moveCopy(stage, [FIRST_BREATH, BREATH_OUT], 180);
    await moveCopy(stage, [BREATH_OUT, SECOND_BREATH], 620, 'ease-out');
    await moveCopy(stage, [SECOND_BREATH, BREATH_QUIVER, SECOND_BREATH, BREATH_QUIVER, SECOND_BREATH], 380, 'linear');

    const achooKeyframes = [
        { transform: SECOND_BREATH, offset: 0, easing: 'cubic-bezier(0.2, 0, 0.1, 1)' },
        { transform: JOLT, offset: 0.15, easing: 'ease-out' },
        { transform: RECOIL, offset: 0.45, easing: 'ease-in-out' },
        { transform: HOME, offset: 1 },
    ];
    const achoo = stage.move(stage.copy, achooKeyframes, { duration: ACHOO_MS });
    const weather = release(stage);

    await achoo;
    await weather;

    // It looks away, a little ashamed.
    await moveCopy(stage, [HOME, SHY], 300);
    await moveCopy(stage, SHY_SHAKE, 360, 'linear');
    await moveCopy(stage, [SHY, HOME], 280);
}

async function sneezeRain(stage: TrickStage): Promise<void> {
    await sneeze(stage, pourRain);
}

async function sneezeSnow(stage: TrickStage): Promise<void> {
    await sneeze(stage, blowBlizzard);
}

async function sneezeBolt(stage: TrickStage): Promise<void> {
    await sneeze(stage, strikeLightning);
}

async function dance(stage: TrickStage): Promise<void> {
    const center = homeCenter(stage);
    const { height, width } = stage.home;

    times(NOTE_COUNT, (index) => {
        const side = index % 2 === 0 ? -1 : 1;
        const notePlace = { x: center.x + side * width * randomBetween(0.5, 1.3), y: center.y + height * 1.5 };

        floatUp(stage, { kind: 'note', center: notePlace, size: 14, rise: 52, delay: index * 300 });
    });

    await moveCopy(stage, [HOME, ...DANCE_BEATS, ...DANCE_BEATS, ...DANCE_BEATS, ...DANCE_BEATS], 3_040);
    await moveCopy(stage, [DANCE_LAST_BEAT, DANCE_POSE], 240, 'ease-out');
    await stage.pause(420);
    await moveCopy(stage, [DANCE_POSE, HOME], 240);
}

function circleStar(stage: TrickStage, index: number): void {
    const center = homeCenter(stage);
    const { height, top, width } = stage.home;
    const orbitCenter = { x: center.x, y: Math.max(top, DAZED_STAR_TOP_MIN) };
    const piece = stage.spawn('star', orbitCenter, 8);
    const phase = index / DAZED_STAR_COUNT * FULL_TURN;
    const keyframes = sample(30, (progress) => {
        const angle = phase + progress * DAZED_STAR_TURNS * FULL_TURN;
        const shrink = 1 - progress * 0.5;
        const offsetX = Math.cos(angle) * width * 0.8 * shrink;
        const depth = Math.sin(angle);
        const opacity = Math.min(1, progress * 8, (1 - progress) * 8) * 0.9;

        return pieceFrame(offsetX, depth * height * 0.22 * shrink, opacity, 0.8 + depth * 0.2, angle * 60);
    });

    void stage.move(piece, keyframes, { duration: WOBBLE_MS, easing: 'linear' });
}

async function dizzy(stage: TrickStage): Promise<void> {
    await moveCopy(stage, [HOME, pose(0, 0, 1, 1, SPIN_TURNS_DEG)], 950, 'ease-in');

    const wobble = sample(36, (progress) => {
        const radius = WOBBLE_RADIUS * (1 - progress);
        const angle = progress * WOBBLE_TURNS * FULL_TURN;
        const offsetY = Math.sin(angle) * radius * 0.6;

        return pose(Math.cos(angle) * radius - radius * (1 - progress), offsetY, 1, 1, offsetY * 2);
    });

    times(DAZED_STAR_COUNT, (index) => {
        circleStar(stage, index);
    });

    await moveCopy(stage, wobble, WOBBLE_MS, 'linear');
    await moveCopy(stage, [HOME, pose(0, 1, 1, 1, -14), pose(0, 0, 1, 1, 6), HOME], 480);
}

async function greet(stage: TrickStage): Promise<void> {
    const { home, pointer } = stage;

    if (pointer === undefined) {
        return;
    }

    const center = homeCenter(stage);
    const side = pointer.x > center.x ? -1 : 1;
    const wanted = { x: pointer.x + side * home.width * 0.9, y: pointer.y - home.height * 0.4 };
    const beside = clampToMain(stage, wanted, home.width * 0.6);
    const offsetX = beside.x - center.x;
    const offsetY = beside.y - center.y;
    const distance = Math.hypot(offsetX, offsetY);
    const heading = Math.sign(offsetX) * 12;
    const there = pose(offsetX, offsetY);
    const midway = pose(offsetX / 2, offsetY / 2 - 24, 0.95, 1.05, heading);
    const flyMs = clamp(distance * 0.8 + 350, 600, 1_200);
    const bounce = [
        pose(offsetX, offsetY, 1.14, 0.84),
        pose(offsetX, offsetY - 12, 0.92, 1.1),
        there,
    ];

    await moveCopy(stage, [HOME, midway, there], flyMs);
    await stage.pause(300);

    times(HEART_COUNT, (index) => {
        const heartPlace = { x: beside.x + randomBetween(-12, 12), y: beside.y - home.height * 0.3 };

        floatUp(stage, { kind: 'heart', center: heartPlace, size: 12, rise: 36, delay: index * 180 });
    });

    await moveCopy(stage, [there, ...bounce, ...bounce, ...bounce], 1_080);
    await moveCopy(stage, [there, midway, HOME], flyMs);
}

// It nods off with heavier and heavier nods, snores, then wakes with a start and stretches as if nothing happened.
async function nodOff(stage: TrickStage): Promise<void> {
    const center = homeCenter(stage);
    const { height, width } = stage.home;
    const firstNod = pose(0, 2, 1.03, 0.96, -5);
    const secondNod = pose(0, 4, 1.06, 0.9, -10);
    const deepNod = pose(0, 6, 1.1, 0.84, -16);
    const snoreIn = pose(0, 5, 1.13, 0.9, -16);
    const stretch = pose(0, -3, 0.9, 1.2, 0);

    await moveCopy(stage, [HOME, firstNod], 700);
    await moveCopy(stage, [firstNod, HOME], 140, 'ease-out');
    await moveCopy(stage, [HOME, secondNod], 900);
    await moveCopy(stage, [secondNod, HOME], 140, 'ease-out');

    times(SNORE_COUNT, (index) => {
        const snorePlace = { x: center.x + width * 0.7, y: center.y + height };

        floatUp(stage, { kind: 'puff', center: snorePlace, size: 14, rise: 28, delay: 900 + index * 500 });
    });

    await moveCopy(stage, [HOME, deepNod], 900);
    await moveCopy(stage, [deepNod, snoreIn, deepNod, snoreIn, deepNod], 1_400);

    burstStars(stage, center);

    await moveCopy(stage, [deepNod, WAKE_POSE], 110, 'ease-out');
    await moveCopy(stage, [WAKE_POSE, pose(-3, -4, 1, 1, -8), pose(3, -4, 1, 1, 8), HOME], 560);
    await moveCopy(stage, [HOME, stretch], 340);
    await stage.pause(160);
    await moveCopy(stage, [stretch, HOME], 240);
}

// The path of a juggled star, a high toss over the head and a low pass back. The first star stays lit, since it gets tossed last.
function juggleStar(stage: TrickStage, hands: Point, index: number): SVGSVGElement {
    const { height, width } = stage.home;
    const piece = stage.spawn('star', hands, 9);
    const phase = Math.PI + index / JUGGLE_STAR_COUNT * FULL_TURN;
    const keyframes = sample(36, (progress) => {
        const angle = phase + progress * JUGGLE_TURNS * FULL_TURN;
        const lift = -Math.sin(angle);
        const offsetY = lift > 0 ? -lift * height * 1.1 : -lift * height * 0.2;
        const fadeOut = index === 0 ? 1 : (1 - progress) * 10;
        const opacity = Math.min(1, progress * 10, fadeOut) * 0.9;

        return pieceFrame(Math.cos(angle) * width * 0.8, offsetY, opacity, 1, angle * 40);
    });

    void stage.move(piece, keyframes, { duration: JUGGLE_MS, easing: 'linear' });

    return piece;
}

// It steps down into the chat, juggles three stars, and the last one lands on its head.
async function juggleStars(stage: TrickStage): Promise<void> {
    const center = homeCenter(stage);
    const { height, width } = stage.home;
    const drop = height * 1.5;
    const hands = { x: center.x, y: center.y + drop };
    const standing = pose(0, drop);
    const swayLeft = pose(-2, drop - 1, 1, 1, -5);
    const swayRight = pose(2, drop - 1, 1, 1, 5);
    const lookUp = pose(0, drop + 1, 1.04, 0.98, -10);
    const bonked = pose(0, drop + 4, 1.22, 0.7, 0);
    const handSide = -width * 0.8;
    const apex = -height * 1.6;
    const headTop = -height * 0.45;

    await moveCopy(stage, [HOME, pose(0, drop * 0.5, 0.96, 1.05), standing], 350);

    const stars = Array.from({ length: JUGGLE_STAR_COUNT }, (_unused, index) => juggleStar(stage, hands, index));
    const swaying = sample(6, progress => (Math.round(progress * 6) % 2 === 0 ? swayLeft : swayRight));

    await moveCopy(stage, [standing, ...swaying, standing], JUGGLE_MS);

    const [lastStar] = stars;

    if (lastStar === undefined) {
        return;
    }

    void moveCopy(stage, [standing, lookUp], 400);
    await stage.move(lastStar, [pieceFrame(handSide, 0, 0.9), pieceFrame(0, apex, 0.9, 1, 180)], { duration: 480, easing: 'ease-out' });
    await stage.move(lastStar, [pieceFrame(0, apex, 0.9, 1, 180), pieceFrame(0, headTop, 0.9, 1, 360)], { duration: 260, easing: 'ease-in' });

    void stage.move(lastStar, [pieceFrame(0, headTop, 0.9), pieceFrame(width * 1.2, headTop - 16, 0.8, 1, 200), pieceFrame(width * 1.8, 0, 0, 1, 400)], { duration: 420 });

    await moveCopy(stage, [lookUp, bonked, standing], 320, 'ease-out');
    await moveCopy(stage, [standing, pose(-3, drop, 1, 1, -8), pose(3, drop, 1, 1, 8), standing], 420);
    await moveCopy(stage, [standing, pose(0, drop * 0.5 - 8, 0.96, 1.05), HOME], 400);
}

// It looks around, hides behind a puff that grows, peeks out on both sides, then bursts out.
async function hidePuff(stage: TrickStage): Promise<void> {
    const center = homeCenter(stage);
    const { height, width } = stage.home;
    const peekRight = pose(width * 0.6, -2, 0.8, 0.8, 12);
    const peekLeft = pose(-width * 0.6, -2, 0.8, 0.8, -12);
    const taDa = pose(0, -10, 1.2, 1.2, -6);
    const lumps = PUFF_LUMPS.map((lump) => {
        const lumpPlace = { x: center.x + lump.x * width, y: center.y + lump.y * height };

        return stage.spawn('puff', lumpPlace, lump.size * width);
    });

    await moveCopy(stage, [HOME, pose(-2, 0, 1, 1, -8), pose(2, 0, 1, 1, 8), HOME], 480);

    lumps.forEach((lump, index) => {
        void stage.move(lump, [pieceFrame(0, 0, 0, 0.2), pieceFrame(0, 0, 1, 1.1), pieceFrame(0, 0, 1, 1)], { duration: 420, delay: index * 70, easing: 'ease-out' });
    });

    await moveCopy(stage, [HOME, TUCKED], 420);
    await stage.pause(650);
    await moveCopy(stage, [TUCKED, peekRight], 300, 'ease-out');
    await stage.pause(350);
    await moveCopy(stage, [peekRight, TUCKED], 130, 'ease-in');
    await stage.pause(500);
    await moveCopy(stage, [TUCKED, peekLeft], 240, 'ease-out');
    await stage.pause(250);
    await moveCopy(stage, [peekLeft, TUCKED], 130, 'ease-in');
    await stage.pause(300);

    lumps.forEach((lump) => {
        void stage.move(lump, [pieceFrame(0, 0, 1, 1), pieceFrame(0, 0, 0, 1.5)], { duration: 200, easing: 'ease-out' });
    });
    burstStars(stage, center);

    await moveCopy(stage, [TUCKED, taDa, HOME], 600, 'ease-out');
}

const WEATHER_TRICKS: Record<string, TrickEntry> = {
    sneezeRain: { run: sneezeRain },
    sneezeSnow: { run: sneezeSnow },
    sneezeBolt: { run: sneezeBolt },
    dance: { run: dance },
    dizzy: { run: dizzy },
    greet: { run: greet, needsPointer: true },
    nodOff: { run: nodOff },
    juggleStars: { run: juggleStars },
    hidePuff: { run: hidePuff },
};

export { WEATHER_TRICKS };
