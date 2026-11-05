import type { Point } from './mascotPointer.ts';
import type { TrickStage } from './mascotStage.ts';
import type { TrickEntry } from './mascotTricks.ts';

// A place and a shape of the copy, relative to home. What is left out stays as it is at home.
interface Pose {
    dx?: number;
    dy?: number;
    sx?: number;
    sy?: number;
    turn?: number;
    fade?: number;
}

// How far the middle of the copy can go from home and stay over the chat column.
interface Room {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

interface Web {
    thread: HTMLElement;
    length: number;
}

// A moment on the web. The stretch is the part of the thread in use, and the angle is its tilt.
interface Swing {
    stretch: number;
    angle: number;
    tall?: number;
}

const EDGE_GAP = 4;
const FULL_TURN = 360;
const RADIANS_PER_DEGREE = Math.PI / 180;
const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.3, 1)';
const EASE_IN = 'cubic-bezier(0.6, 0, 0.9, 0.5)';
const EASE_POP = 'cubic-bezier(0.3, 1.5, 0.5, 1)';
const WEB_LIFT = 6;
const WIDEST_SWING = 35;
const SWING_STEPS = 32;
const CLIMB_PULLS = 4;
const FLY_SCALE = 2;
const FLY_STEPS = 32;
const FLY_ROUNDS = 2;
const FLY_BANK = 28;
const BALLOON_SCALE = 3;
const INFLATE_STEPS = 18;
const ZIGZAG_STEP_MS = 170;
// Where the balloon goes, as a part of the room across and down.
const ZIGZAG: Point[] = [
    { x: -1, y: 0.15 },
    { x: 1, y: 0.4 },
    { x: -0.6, y: 0.75 },
    { x: 0.8, y: 0.25 },
    { x: -1, y: 0.6 },
    { x: 0.5, y: 1 },
    { x: -0.3, y: 0.35 },
    { x: 0.9, y: 0.6 },
    { x: 0, y: 0.2 },
];

function toKeyframe(pose: Pose): Keyframe {
    const { dx = 0, dy = 0, sx = 1, sy = 1, turn = 0, fade = 1 } = pose;

    return {
        transform: `translate(${String(dx)}px, ${String(dy)}px) scale(${String(sx)}, ${String(sy)}) rotate(${String(turn)}deg)`,
        opacity: fade,
    };
}

function play(stage: TrickStage, poses: Pose[], durationMs: number, easing = 'linear'): Promise<void> {
    const keyframes = poses.map(toKeyframe);

    return stage.move(stage.copy, keyframes, { duration: durationMs, easing });
}

function centerOf(stage: TrickStage): Point {
    return {
        x: stage.home.left + stage.home.width / 2,
        y: stage.home.top + stage.home.height / 2,
    };
}

function roomFor(stage: TrickStage, scale: number): Room {
    const center = centerOf(stage);
    const halfWidth = stage.home.width * scale / 2 + EDGE_GAP;
    const halfHeight = stage.home.height * scale / 2 + EDGE_GAP;

    return {
        left: stage.main.left + halfWidth - center.x,
        right: stage.main.right - halfWidth - center.x,
        top: stage.main.top + halfHeight - center.y,
        bottom: stage.main.bottom - halfHeight - center.y,
    };
}

// Squashes under 1 and stretches over 1, with the feet staying on the ground.
function squashed(height: number, tall: number, place: Pose = {}): Pose {
    return {
        ...place,
        sx: 2 - tall,
        sy: tall,
        dy: (place.dy ?? 0) + height * (1 - tall) / 2,
    };
}

function landHome(stage: TrickStage, from: Pose): Promise<void> {
    const { height } = stage.home;
    const squash = squashed(height, 0.68);
    const rebound = squashed(height, 1.16);
    const leanLeft = { ...squashed(height, 0.95), turn: -7 };
    const leanRight = { ...squashed(height, 1.03), turn: 5 };

    return play(stage, [from, squash, rebound, leanLeft, leanRight, { turn: -2 }, {}], 700);
}

async function flip(stage: TrickStage): Promise<void> {
    const { height } = stage.home;
    const crouch = squashed(height, 0.6);
    const shakeLeft = { ...crouch, dx: -1 };
    const shakeRight = { ...crouch, dx: 1 };
    const launch = squashed(height, 1.35);
    // The header has little room above it, so the height comes mostly from growing toward the viewer.
    const room = roomFor(stage, 1.6);
    const rise = Math.max(room.top, -36);
    const apex = { dy: Math.min(0, rise), sx: 1.6, sy: 1.6, turn: -200 };
    const touch = { ...squashed(height, 1.2), turn: -FULL_TURN };
    const touchUpright = squashed(height, 1.2);

    await play(stage, [{}, crouch], 420, EASE_OUT);
    await play(stage, [crouch, shakeLeft, shakeRight, shakeLeft, shakeRight, crouch], 300);
    await play(stage, [crouch, launch], 90, EASE_IN);
    await play(stage, [launch, apex], 420, EASE_OUT);
    await play(stage, [apex, touch], 340, EASE_IN);
    await landHome(stage, touchUpright);
    await stage.pause(150);
    await play(stage, [{}, { sx: 1.12, sy: 1.12 }, {}], 400, 'ease-in-out');
}

// The copy hangs upside down at the end of the thread, which turns around the top of the screen.
function swingPose(stage: TrickStage, length: number, swing: Swing): Pose {
    const { tall = 1 } = swing;
    const radians = swing.angle * RADIANS_PER_DEGREE;
    const reach = length * swing.stretch + stage.home.height / 2;
    const center = centerOf(stage);

    return {
        dx: -reach * Math.sin(radians),
        dy: reach * Math.cos(radians) - center.y,
        sx: 2 - tall,
        sy: tall,
        turn: FULL_TURN / 2 + swing.angle,
    };
}

function threadFrame(swing: Swing): Keyframe {
    return { transform: `rotate(${String(swing.angle)}deg) scaleY(${String(swing.stretch)})` };
}

function playSwing(stage: TrickStage, web: Web, swings: Swing[], durationMs: number, easing = 'linear'): Promise<void> {
    const poses = swings.map(swing => swingPose(stage, web.length, swing));
    const threadFrames = swings.map(threadFrame);

    void stage.move(web.thread, threadFrames, { duration: durationMs, easing });

    return play(stage, poses, durationMs, easing);
}

function widestAngle(stage: TrickStage, reach: number): number {
    const room = roomFor(stage, 1);
    const side = Math.min(room.right, -room.left);
    const sideRatio = Math.min(1, side / reach);
    const sideAngle = Math.asin(sideRatio) / RADIANS_PER_DEGREE;

    return Math.min(WIDEST_SWING, sideAngle);
}

async function hang(stage: TrickStage): Promise<void> {
    const { height, top } = stage.home;
    const center = centerOf(stage);
    const drop = Math.min(stage.main.height * 0.38, 190);
    const length = top + drop;
    const web: Web = { thread: stage.spawnThread({ x: center.x, y: 0 }, length), length };
    const reach = length + height / 2;
    const above = Math.max(top - WEB_LIFT, 1) / length;
    const atTop: Swing = { stretch: above, angle: 0 };
    const atEnd: Swing = { stretch: 1, angle: 0 };
    const hidden: Swing = { stretch: 0, angle: 0 };
    const lookUp = squashed(height, 1.12);
    const crouch = squashed(height, 0.65);
    const grabbed = swingPose(stage, length, atTop);
    const widest = widestAngle(stage, reach);
    const swings = Array.from({ length: SWING_STEPS + 1 }, (_, index): Swing => {
        const progress = index / SWING_STEPS;
        const wave = Math.sin(progress * 4 * Math.PI);

        return { stretch: 1, angle: widest * wave * (1 - 0.55 * progress) };
    });
    // Each pull goes up with a little rock and then holds for a moment.
    const climbSteps = CLIMB_PULLS * 2;
    const climb = Array.from({ length: climbSteps + 1 }, (_, index): Swing => {
        const pulls = Math.ceil(index / 2);
        const rock = index % 2 === 0 ? -3 : 3;

        return {
            stretch: 1 - (1 - above) * pulls / CLIMB_PULLS,
            angle: index === 0 || index === climbSteps ? 0 : rock,
        };
    });
    const threadDownFrames = [hidden, atTop].map(threadFrame);
    const threadUpFrames = [atTop, hidden].map(threadFrame);

    await stage.move(web.thread, threadDownFrames, { duration: 380, easing: EASE_IN });
    await stage.pause(160);
    await play(stage, [{}, lookUp], 220, EASE_OUT);
    await play(stage, [lookUp, crouch], 200, EASE_OUT);
    await play(stage, [crouch, grabbed], 260, EASE_OUT);
    await playSwing(stage, web, [atTop, { stretch: 1, angle: 0, tall: 1.25 }], 420, EASE_IN);
    await playSwing(stage, web, [
        { stretch: 1, angle: 0, tall: 1.25 },
        { stretch: 1.07, angle: 0, tall: 0.88 },
        { stretch: 0.97, angle: 0, tall: 1.06 },
        { stretch: 1.01, angle: 0 },
        atEnd,
    ], 420);
    await playSwing(stage, web, swings, 2200);
    await stage.pause(120);
    await playSwing(stage, web, climb, 1200);
    void stage.move(web.thread, threadUpFrames, { duration: 320, easing: EASE_IN });
    await play(stage, [grabbed, { turn: FULL_TURN }], 300, EASE_IN);
    await landHome(stage, {});
}

async function fly(stage: TrickStage): Promise<void> {
    const { height } = stage.home;
    const room = roomFor(stage, FLY_SCALE);
    const middleX = (room.left + room.right) / 2;
    const wide = Math.min((room.right - room.left) / 2, 320);
    const high = Math.min((room.bottom - room.top) / 2, 200);
    const middleY = room.top + high;
    const crouch = squashed(height, 0.62);
    const launch = squashed(height, 1.3);
    const loops = Array.from({ length: FLY_STEPS + 1 }, (_, index): Pose => {
        const angle = index / FLY_STEPS * FLY_ROUNDS * 2 * Math.PI;

        return {
            dx: middleX + wide * Math.sin(angle),
            dy: middleY - high * Math.cos(angle),
            sx: FLY_SCALE,
            sy: FLY_SCALE,
            turn: FLY_BANK * Math.cos(angle),
        };
    });
    const loopStart = loops[0] as Pose;
    const swoop = {
        dx: middleX * 0.4,
        dy: (room.top + middleY) / 2,
        sx: 1.4,
        sy: 1.4,
        turn: -14,
    };
    const arrival = { sx: 1.05, sy: 1.05, turn: 5 };

    await play(stage, [{}, crouch], 260, EASE_OUT);
    await play(stage, [crouch, launch], 90, EASE_IN);
    await play(stage, [launch, loopStart], 560, EASE_OUT);
    await play(stage, loops, 3800, 'ease-in-out');
    await play(stage, [loopStart, swoop, arrival], 900, 'ease-out');
    await landHome(stage, arrival);
}

async function fall(stage: TrickStage): Promise<void> {
    const { height } = stage.home;
    const room = roomFor(stage, 1);
    const floor = room.bottom - height * 2;
    const drift = Math.min(24, room.right);
    const firstBounce = Math.min(90, floor * 0.35);
    const secondBounce = firstBounce / 2;
    const ground = { dx: drift, dy: floor };
    const teeter = { dx: 10, turn: 20 };
    const startled = { dx: 14, dy: -2, sx: 1.1, sy: 0.9, turn: 24 };
    const faller = { ...ground, sx: 0.85, sy: 1.25, turn: FULL_TURN };
    const fallerUpright = { ...ground, sx: 0.85, sy: 1.25 };
    const squashHard = squashed(height, 0.55, ground);
    const squashMid = squashed(height, 0.7, ground);
    const squashSoft = squashed(height, 0.85, ground);
    const firstTop = { dx: drift, dy: floor - firstBounce, sx: 0.9, sy: 1.12 };
    const secondTop = { dx: drift, dy: floor - secondBounce, sx: 0.95, sy: 1.06 };
    const shake = { ...ground, dx: drift + 4, turn: 10 };
    const shakeBack = { ...ground, dx: drift - 4, turn: -10 };
    const crouch = squashed(height, 0.6, ground);
    const overHome = { dy: -6, sx: 0.88, sy: 1.18 };
    const touch = squashed(height, 1.1);

    await play(stage, [{}, { dx: 6, turn: 10 }, { dx: -5, turn: -14 }, teeter], 500);
    await play(stage, [teeter, startled], 180, EASE_OUT);
    await stage.pause(120);
    await play(stage, [startled, faller], 620, EASE_IN);
    await play(stage, [fallerUpright, squashHard], 90, EASE_OUT);
    await play(stage, [squashHard, firstTop], 220, EASE_OUT);
    await play(stage, [firstTop, fallerUpright], 220, EASE_IN);
    await play(stage, [fallerUpright, squashMid], 70, EASE_OUT);
    await play(stage, [squashMid, secondTop], 170, EASE_OUT);
    await play(stage, [secondTop, ground], 170, EASE_IN);
    await play(stage, [ground, squashSoft], 80, EASE_OUT);
    await play(stage, [squashSoft, ground], 90);
    await stage.pause(300);
    await play(stage, [ground, shake, shakeBack, shake, shakeBack, shake, ground], 420);
    await play(stage, [ground, crouch], 240, EASE_OUT);
    await play(stage, [crouch, overHome], 460, EASE_OUT);
    await play(stage, [overHome, touch], 120, EASE_IN);
    await landHome(stage, touch);
}

async function peek(stage: TrickStage): Promise<void> {
    const center = centerOf(stage);
    const { height, width } = stage.home;
    const halfDx = stage.main.right - center.x;
    const hiddenDx = halfDx + width / 2;
    const dy = stage.main.top + stage.main.height * 0.4 - center.y;
    const swell = { sx: 1.1, sy: 1.1 };
    const tiny = { sx: 0.05, sy: 0.05, fade: 0 };
    const hidden = { dx: hiddenDx, dy, turn: -12, fade: 0 };
    const peeking = { dx: halfDx, dy, turn: -12 };
    const lookingUp = { dx: halfDx, dy: dy - 4, turn: -24 };
    const lookingDown = { dx: halfDx, dy: dy + 6, turn: 10 };
    const popped = { sx: 1.3, sy: 1.3 };
    const touch = squashed(height, 1.1);

    await play(stage, [{}, swell], 140, EASE_OUT);
    await play(stage, [swell, tiny], 300, EASE_IN);
    await stage.pause(500);
    await play(stage, [hidden, peeking], 420, EASE_POP);
    await play(stage, [peeking, lookingUp], 300, 'ease-in-out');
    await stage.pause(250);
    await play(stage, [lookingUp, lookingDown], 360, 'ease-in-out');
    await stage.pause(250);
    await play(stage, [lookingDown, hidden], 180, EASE_IN);
    await stage.pause(300);
    await play(stage, [tiny, popped, touch], 260, EASE_OUT);
    await landHome(stage, touch);
}

function leavePuffs(stage: TrickStage, poses: Pose[]): void {
    const center = centerOf(stage);

    poses.forEach((pose, index) => {
        if (index % 2 === 1) {
            return;
        }

        const puffCenter = { x: center.x + (pose.dx ?? 0), y: center.y + (pose.dy ?? 0) };
        const piece = stage.spawn('puff', puffCenter, stage.home.width * 0.5);
        const frames = [
            { opacity: 0, transform: 'scale(0.4)' },
            { opacity: 0.8, transform: 'scale(1)' },
            { opacity: 0, transform: 'translateY(-14px) scale(1.5)' },
        ];

        void stage.move(piece, frames, { duration: 700, delay: index * ZIGZAG_STEP_MS, easing: 'ease-out' });
    });
}

async function balloon(stage: TrickStage): Promise<void> {
    const room = roomFor(stage, BALLOON_SCALE);
    const lowest = Math.min(room.top + 360, room.bottom);
    const middleX = (room.left + room.right) / 2;
    const halfWide = (room.right - room.left) / 2;
    const grownDy = Math.max(0, room.top);
    // It grows by steps with a tremble that gets worse.
    const inflate = Array.from({ length: INFLATE_STEPS + 1 }, (_, index): Pose => {
        const progress = index / INFLATE_STEPS;
        const scale = 1 + (BALLOON_SCALE - 1) * progress;
        const side = index % 2 === 0 ? 1 : -1;

        return {
            dx: index === 0 ? 0 : side * (1 + 2 * progress),
            dy: grownDy * progress,
            sx: scale,
            sy: scale,
            turn: index === 0 ? 0 : side * 3 * progress,
        };
    });
    const full = inflate[INFLATE_STEPS] as Pose;
    const zigzag = ZIGZAG.map((point, index): Pose => {
        const scale = 2.6 - 1.8 * index / (ZIGZAG.length - 1);

        return {
            dx: middleX + halfWide * point.x,
            dy: room.top + (lowest - room.top) * point.y,
            sx: scale,
            sy: scale,
            turn: (index % 2 === 0 ? -1 : 1) * 40,
        };
    });
    const lastTurn = zigzag.at(-1) as Pose;
    const limp = { sx: 0.6, sy: 0.6 };
    const driftOne = { dx: (lastTurn.dx ?? 0) * 0.6 + 14, dy: (lastTurn.dy ?? 0) * 0.6, sx: 0.7, sy: 0.7, turn: 12 };
    const driftTwo = { dx: (lastTurn.dx ?? 0) * 0.25 - 10, dy: (lastTurn.dy ?? 0) * 0.25, sx: 0.65, sy: 0.65, turn: -10 };
    const popped = { sx: 1.25, sy: 1.25 };
    const touch = squashed(stage.home.height, 1.08);

    await play(stage, inflate, 1400, 'ease-in');
    await stage.pause(200);
    leavePuffs(stage, zigzag);
    await play(stage, [full, ...zigzag], ZIGZAG_STEP_MS * zigzag.length);
    await play(stage, [lastTurn, driftOne, driftTwo, limp], 1100, 'ease-out');
    await stage.pause(200);
    await play(stage, [limp, popped, touch], 240, EASE_OUT);
    await landHome(stage, touch);
}

const MOVE_TRICKS: Record<string, TrickEntry> = {
    hang: { run: hang },
    fly: { run: fly },
    fall: { run: fall },
    flip: { run: flip },
    peek: { run: peek },
    balloon: { run: balloon },
};

export { MOVE_TRICKS };
