import type { Point } from './mascotPointer.ts';
import type { TrickPieceKind, TrickStage } from './mascotStage.ts';
import type { TrickEntry } from './mascotTricks.ts';

// How an element stands, relative to its place. A positive squash flattens it, and a negative one stretches it.
interface Pose {
    x: number;
    y: number;
    scale: number;
    turn: number;
    squash: number;
}

// Another bot that a trick visits, measured before anything moves.
interface Visit {
    element: HTMLElement;
    rect: DOMRect;
    // The screen point at the top of the other bot, where the pieces start.
    top: Point;
    // The copy touching the top of the other bot.
    contact: Pose;
    // The copy just above the other bot. This stays in the column of the mascots, so it never hides a name.
    perch: Pose;
}

interface PieceBurst {
    kind: TrickPieceKind;
    center: Point;
    count: number;
}

const HOME: Pose = { x: 0, y: 0, scale: 1, turn: 0, squash: 0 };
const ARC_STEPS = 8;
const ARC_SHARES = Array.from({ length: ARC_STEPS + 1 }, (_unused, index) => index / ARC_STEPS);
const ARC_LEAN_DEG = 40;
const PERCH_SHARE = 0.72;
const CONTACT_SHARE = 0.38;
const PIECE_SIZE_PX = 14;
const TIPTOE_STEPS = 9;
const DANCE_SIDES = [-1, 1, -1, 1, -1, 1];
const DANCE_MS = 2100;
const ROLL_CALL_MOST = 5;
// A real mascot lives inside the scrolling list, so it clips past the edges and must not pass the right one.
const LIST_EDGE_PX = 16;
const LONGEST_RUN_PX = 150;

function toFrame(pose: Pose): Keyframe {
    const wide = pose.scale * (1 + pose.squash);
    const tall = pose.scale * (1 - pose.squash);
    const size = pose.squash === 0 ? String(pose.scale) : `${String(wide)}, ${String(tall)}`;

    return { transform: `translate(${String(pose.x)}px, ${String(pose.y)}px) scale(${size}) rotate(${String(pose.turn)}deg)` };
}

function act(stage: TrickStage, element: Element, poses: Pose[], duration: number, easing = 'ease-in-out'): Promise<void> {
    const keyframes = poses.map(toFrame);

    return stage.move(element, keyframes, { duration, easing });
}

// A curved flight of the copy. The curve never goes above the top of the page, which would clip it.
function fly(stage: TrickStage, from: Pose, to: Pose, duration: number, lift: number): Promise<void> {
    const peakX = (from.x + to.x) / 2;
    const peakY = Math.max((from.y + to.y) / 2 - lift, -stage.home.top);
    const lean = to.x < from.x ? -ARC_LEAN_DEG : ARC_LEAN_DEG;
    const keyframes = ARC_SHARES.map((share) => {
        const before = 1 - share;

        return toFrame({
            x: before * before * from.x + 2 * before * share * peakX + share * share * to.x,
            y: before * before * from.y + 2 * before * share * peakY + share * share * to.y,
            scale: before * from.scale + share * to.scale,
            turn: before * from.turn + share * to.turn + before * share * lean,
            squash: 0,
        });
    });

    return stage.move(stage.copy, keyframes, { duration, easing: 'cubic-bezier(0.45, 0.05, 0.35, 1)' });
}

function measure(stage: TrickStage, element: HTMLElement): Visit {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const offsetX = centerX - (stage.home.left + stage.home.width / 2);
    const offsetY = centerY - (stage.home.top + stage.home.height / 2);
    const scale = rect.width / stage.home.width;

    return {
        element,
        rect,
        top: { x: centerX, y: rect.top },
        contact: { ...HOME, x: offsetX, y: offsetY - rect.height * CONTACT_SHARE, scale, squash: 0.16 },
        perch: { ...HOME, x: offsetX, y: offsetY - rect.height * PERCH_SHARE, scale },
    };
}

// A random visit. There can be none, since the count that picks the trick also includes mascots off screen.
function pickVisit(stage: TrickStage, elements: HTMLElement[]): Visit | undefined {
    const randomValue = Math.random();
    const element = elements[Math.floor(randomValue * elements.length)];

    return element === undefined ? undefined : measure(stage, element);
}

// Pieces that float up one after the other, from side to side.
function floatPieces(stage: TrickStage, burst: PieceBurst, gapMs: number): void {
    const indexes = Array.from({ length: burst.count }, (_unused, index) => index);

    indexes.forEach((index) => {
        const side = index % 2 === 0 ? -1 : 1;
        const start = { x: burst.center.x + side * 9, y: burst.center.y };
        const piece = stage.spawn(burst.kind, start, PIECE_SIZE_PX);
        const keyframes: Keyframe[] = [
            { opacity: 0, transform: 'translate(0px, 6px) scale(0.5)' },
            { opacity: 1, transform: `translate(${String(side * 3)}px, -12px) scale(1)`, offset: 0.25 },
            { opacity: 0, transform: `translate(${String(side * 10)}px, -46px) scale(0.9)` },
        ];

        void stage.move(piece, keyframes, { duration: 1000, delay: index * gapMs, easing: 'ease-out' });
    });
}

// Pieces that fly out in a circle, all at once.
function burstPieces(stage: TrickStage, burst: PieceBurst): void {
    const indexes = Array.from({ length: burst.count }, (_unused, index) => index);

    indexes.forEach((index) => {
        const angle = index / burst.count * 2 * Math.PI;
        const outX = Math.cos(angle) * 34;
        const outY = Math.sin(angle) * 34;
        const piece = stage.spawn(burst.kind, burst.center, PIECE_SIZE_PX);
        const keyframes: Keyframe[] = [
            { opacity: 1, transform: 'translate(0px, 0px) scale(0.4) rotate(0deg)' },
            { opacity: 1, transform: `translate(${String(outX * 0.7)}px, ${String(outY * 0.7)}px) scale(1.1) rotate(70deg)`, offset: 0.5 },
            { opacity: 0, transform: `translate(${String(outX)}px, ${String(outY)}px) scale(0.7) rotate(140deg)` },
        ];

        void stage.move(piece, keyframes, { duration: 650, easing: 'ease-out' });
    });
}

// The copy winds up over the other bot and drops on it. It ends touching, ready for the other bot to react.
async function dropOn(stage: TrickStage, visit: Visit): Promise<void> {
    const windUp = { ...visit.perch, y: visit.perch.y - 9, squash: -0.09 };

    await act(stage, stage.copy, [visit.perch, windUp], 190, 'ease-out');
    await act(stage, stage.copy, [windUp, visit.contact], 110, 'ease-in');
}

async function boop(stage: TrickStage): Promise<void> {
    const visit = pickVisit(stage, stage.others);

    if (visit === undefined) {
        return;
    }

    const { contact, element, perch, top } = visit;
    const knockedAside: Pose[] = [
        HOME,
        { ...HOME, x: -13, y: 7, turn: -24, squash: 0.12 },
        { ...HOME, x: 6, y: -3, turn: 11, squash: -0.05 },
        { ...HOME, x: -4, y: 1, turn: -7 },
        { ...HOME, x: 2, turn: 3 },
        HOME,
    ];
    const rebound = { ...perch, y: perch.y - 7, squash: -0.06 };
    const pleased: Pose[] = [perch, { ...perch, turn: -9 }, { ...perch, turn: 9 }, { ...perch, turn: -6 }, perch];

    await fly(stage, HOME, perch, 850, 90);
    await stage.pause(260);
    await dropOn(stage, visit);
    void act(stage, element, knockedAside, 1000, 'ease-out');
    floatPieces(stage, { kind: 'heart', center: top, count: 3 }, 170);
    await act(stage, stage.copy, [contact, rebound, perch], 340, 'ease-out');
    await act(stage, stage.copy, pleased, 760);
    await fly(stage, perch, HOME, 800, 70);
}

// The same dance for any pose, so both bots move in sync when they start together.
function dancePoses(base: Pose): Pose[] {
    const steps = DANCE_SIDES.flatMap(side => [
        { ...base, x: base.x + side * 9, y: base.y - 6, turn: side * 13, squash: -0.04 },
        { ...base, squash: 0.08 },
    ]);

    return [base, ...steps, base];
}

async function party(stage: TrickStage): Promise<void> {
    const visit = pickVisit(stage, stage.others);

    if (visit === undefined) {
        return;
    }

    const { element, perch, top } = visit;
    const copyDance = dancePoses(perch);
    const otherDance = dancePoses(HOME);
    const copyCrouch = { ...perch, y: perch.y - 3, squash: 0.15 };
    const otherCrouch = { ...HOME, y: 3, squash: 0.15 };
    const copyMeet = { ...perch, y: perch.y + 7, squash: -0.1 };
    const otherMeet = { ...HOME, y: -11, squash: -0.1 };
    const copyBack = { ...perch, y: perch.y - 13, turn: 11 };
    const otherBack = { ...HOME, y: 4, turn: -9, squash: 0.1 };

    await fly(stage, HOME, perch, 850, 90);
    await stage.pause(160);
    floatPieces(stage, { kind: 'note', center: top, count: 6 }, DANCE_MS / 6);
    await Promise.all([
        act(stage, stage.copy, copyDance, DANCE_MS, 'linear'),
        act(stage, element, otherDance, DANCE_MS, 'linear'),
    ]);
    await Promise.all([
        act(stage, stage.copy, [perch, copyCrouch], 240, 'ease-out'),
        act(stage, element, [HOME, otherCrouch], 240, 'ease-out'),
    ]);
    await Promise.all([
        act(stage, stage.copy, [copyCrouch, copyMeet], 130, 'ease-in'),
        act(stage, element, [otherCrouch, otherMeet], 130, 'ease-in'),
    ]);
    burstPieces(stage, { kind: 'star', center: top, count: 6 });
    await Promise.all([
        act(stage, stage.copy, [copyMeet, copyBack, perch], 420, 'ease-out'),
        act(stage, element, [otherMeet, otherBack, HOME], 420, 'ease-out'),
    ]);
    await stage.pause(240);
    await fly(stage, perch, HOME, 800, 70);
}

// Small careful steps in a straight line, each one up on its toes.
function tiptoePoses(from: Pose, to: Pose): Pose[] {
    const frameCount = TIPTOE_STEPS * 2 + 1;
    const indexes = Array.from({ length: frameCount }, (_unused, index) => index);

    return indexes.map((index) => {
        const share = index / (frameCount - 1);
        const isUp = index % 2 === 1;
        const turn = index % 4 === 1 ? -7 : 7;

        return {
            x: from.x + (to.x - from.x) * share,
            y: from.y + (to.y - from.y) * share - (isUp ? 7 : 0),
            scale: from.scale + (to.scale - from.scale) * share,
            turn: isUp ? turn : 0,
            squash: isUp ? -0.06 : 0,
        };
    });
}

async function wakeUp(stage: TrickStage): Promise<void> {
    const sleepers = stage.others.filter(element => element.dataset.effect === 'sleeping');
    const visit = pickVisit(stage, sleepers.length > 0 ? sleepers : stage.others);

    if (visit === undefined) {
        return;
    }

    const { contact, element, perch, top } = visit;
    const steps = tiptoePoses(HOME, perch);
    const startled: Pose[] = [
        HOME,
        { ...HOME, y: 4, squash: 0.2 },
        { ...HOME, y: -24, scale: 1.08, squash: -0.14, turn: -8 },
        { ...HOME, y: -19, turn: 10 },
        { ...HOME, y: -21, turn: -10 },
        { ...HOME, y: 3, squash: 0.12 },
        { ...HOME, turn: 4 },
        HOME,
    ];
    const caught = { ...perch, y: perch.y - 14, scale: perch.scale * 1.1, squash: -0.12 };
    // It overshoots home in its hurry, then settles.
    const rush: Pose[] = [caught, { ...HOME, x: 9, y: -3, squash: 0.14 }, HOME];

    await act(stage, stage.copy, steps, 2600, 'linear');
    await stage.pause(420);
    await dropOn(stage, visit);

    const wakingUp = act(stage, element, startled, 950, 'ease-out');

    floatPieces(stage, { kind: 'star', center: top, count: 1 }, 0);
    await act(stage, stage.copy, [contact, caught], 170, 'ease-out');
    // A frozen beat, as it sees what it has done.
    await stage.pause(230);
    await act(stage, stage.copy, rush, 480, 'ease-in');
    await wakingUp;
}

// The other bot runs after the copy, then gets tired and walks back to its place.
async function runAfter(stage: TrickStage, element: Element, route: Pose[]): Promise<void> {
    const lastStop = route.at(-1) ?? HOME;
    const panting: Pose[] = [
        lastStop,
        { ...lastStop, squash: 0.12 },
        { ...lastStop, squash: -0.03 },
        { ...lastStop, squash: 0.12 },
        lastStop,
    ];

    await stage.pause(280);
    await act(stage, element, [HOME, ...route], 1300, 'ease-in-out');
    await act(stage, element, panting, 620);
    await act(stage, element, [lastStop, HOME], 750);
}

async function chase(stage: TrickStage): Promise<void> {
    const visit = pickVisit(stage, stage.others);

    if (visit === undefined) {
        return;
    }

    const { contact, element, perch, rect } = visit;
    const roomX = stage.main.left - rect.right - LIST_EDGE_PX;
    const cappedX = Math.min(roomX, LONGEST_RUN_PX);
    const runX = Math.max(cappedX, 0);
    // The run goes toward the middle of the list, so it stays inside the scrolling box.
    const runY = rect.top < stage.main.top + stage.main.height / 2 ? 1 : -1;
    const route: Pose[] = [
        { ...HOME, x: runX, y: runY * 24, turn: 9 },
        { ...HOME, x: runX * 0.6, y: runY * 76, turn: -6 },
        { ...HOME, x: runX * 0.2, y: runY * 48, turn: -10 },
    ];
    const copyRoute = route.map(stop => ({ ...stop, x: contact.x + stop.x, y: contact.y + stop.y, scale: contact.scale }));
    const copyStop = copyRoute.at(-1) ?? perch;
    const angry: Pose[] = [
        HOME,
        { ...HOME, y: 3, squash: 0.14 },
        { ...HOME, turn: -11 },
        { ...HOME, turn: 11 },
        { ...HOME, turn: -11 },
        { ...HOME, turn: 11 },
        HOME,
    ];
    const rebound = { ...perch, y: perch.y - 7, squash: -0.06 };

    await fly(stage, HOME, perch, 850, 90);
    await stage.pause(200);
    await dropOn(stage, visit);
    await act(stage, stage.copy, [contact, rebound, perch], 260, 'ease-out');
    // The other bot gets angry while the copy stares, frozen.
    await act(stage, element, angry, 620);

    const chasing = runAfter(stage, element, route);

    await act(stage, stage.copy, [perch, ...copyRoute], 1300, 'ease-in-out');
    await Promise.all([chasing, fly(stage, copyStop, HOME, 760, 60)]);
}

// One stop of the roll call. The copy hops over, taps the other bot, and the other bot hops in reply.
async function callOne(stage: TrickStage, visit: Visit, from: Pose): Promise<Pose> {
    const { element, perch } = visit;
    const isFirst = from === HOME;
    const tap = { ...perch, y: perch.y + 8, squash: 0.12 };
    const reply: Pose[] = [
        HOME,
        { ...HOME, y: 3, squash: 0.16 },
        { ...HOME, y: -19, squash: -0.1 },
        { ...HOME, y: 1, squash: 0.08 },
        HOME,
    ];

    await fly(stage, from, perch, isFirst ? 850 : 400, isFirst ? 90 : 24);
    await stage.pause(120);
    await act(stage, stage.copy, [perch, tap, perch], 220);
    await act(stage, element, reply, 400, 'ease-out');

    return perch;
}

async function rollCall(stage: TrickStage): Promise<void> {
    const called = stage.others.slice(0, ROLL_CALL_MOST);
    const visits = called.map(element => measure(stage, element));

    if (visits.length === 0) {
        return;
    }

    const start = Promise.resolve(HOME);
    const lastPerch = await visits.reduce((chain, visit) => chain.then(from => callOne(stage, visit, from)), start);
    const nod: Pose[] = [lastPerch, { ...lastPerch, y: lastPerch.y + 5, turn: 7 }, lastPerch];

    await stage.pause(300);
    await act(stage, stage.copy, nod, 320);
    await fly(stage, lastPerch, HOME, 800, 70);
}

const VISIT_TRICKS: Record<string, TrickEntry> = {
    boop: { run: boop, needsOthers: true },
    party: { run: party, needsOthers: true },
    wakeUp: { run: wakeUp, needsOthers: true },
    chase: { run: chase, needsOthers: true },
    rollCall: { run: rollCall, needsOthers: true },
};

export { VISIT_TRICKS };
