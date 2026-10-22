import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { MASCOT_COLORS, readMascotColor } from '../../shared/mascot.ts';
import type { MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { computeEyeOffset, computeTypingEyeOffset, subscribeToPointer, subscribeToTyping } from '../mascotPointer.ts';
import type { Point } from '../mascotPointer.ts';
import type { MascotState } from '../mascotState.ts';

interface CloudMascotProps {
    color: MascotColorName;
    shape: MascotShape;
    state: MascotState;
    // Width and height in pixels. The cloud keeps its proportions.
    size?: number;
}

interface CircleSpec {
    cx: number;
    cy: number;
    r: number;
}

interface BaseSpec {
    x: number;
    y: number;
    width: number;
    height: number;
    rx: number;
}

// A body is a few circles over a flat base with rounded ends. Some bodies have a small floating dot.
interface BodySpec {
    circles: CircleSpec[];
    base: BaseSpec;
    dot?: CircleSpec;
}

const VIEW_BOX = '-10 -10 160 130';
const WHITE = '#ffffff';
const EYE_Y = 70;
const LEFT_EYE_X = 52;
const RIGHT_EYE_X = 88;
// Half the width of an arc eye, and how far its arc bulges.
const EYE_HALF_WIDTH = 9;
const EYE_BULGE = 10;
const EYE_RADIUS = 7;
const FACE_STROKE_WIDTH = 7;
const SPARKLE_RADIUS = 11;
// How far the eyes may move toward the pointer, in viewBox units. Nine keeps the eyes inside the face of every body.
const EYE_MAX_OFFSET = 9;
// While the owner types, the eyes look down at the text box. The mascots sit above it.
const TYPING_LOOK_DOWN = 6;
// The whole cloud leans and shifts a little toward the look, so the look still reads on a small mascot.
const LOOK_TILT_DEG_PER_UNIT = 0.8;
const LOOK_SHIFT_PER_UNIT = 0.3;
const DEFAULT_SIZE = 40;
const NO_EYE_OFFSET: Point = { x: 0, y: 0 };
// The pause between two blinks is random between these two delays.
const BLINK_MIN_DELAY_MS = 2500;
const BLINK_MAX_DELAY_MS = 6000;
const BLINK_DURATION_MS = 150;

const BODY_SPECS: Record<MascotShape, BodySpec> = {
    puff: {
        circles: [{ cx: 40, cy: 68, r: 30 }, { cx: 72, cy: 46, r: 36 }, { cx: 104, cy: 66, r: 28 }],
        base: { x: 12, y: 66, width: 118, height: 40, rx: 20 },
    },
    tall: {
        circles: [{ cx: 42, cy: 72, r: 24 }, { cx: 72, cy: 48, r: 30 }, { cx: 102, cy: 72, r: 24 }],
        base: { x: 18, y: 72, width: 108, height: 40, rx: 20 },
    },
    wide: {
        circles: [{ cx: 30, cy: 72, r: 22 }, { cx: 56, cy: 54, r: 26 }, { cx: 92, cy: 54, r: 26 }, { cx: 120, cy: 72, r: 22 }],
        base: { x: 8, y: 72, width: 134, height: 40, rx: 20 },
    },
    bubble: {
        circles: [{ cx: 38, cy: 72, r: 26 }, { cx: 68, cy: 52, r: 30 }, { cx: 100, cy: 74, r: 24 }],
        base: { x: 14, y: 72, width: 110, height: 40, rx: 20 },
        dot: { cx: 132, cy: 18, r: 9 },
    },
};

// A happy closed eye, an arc that bulges up.
function smileArc(centerX: number): string {
    const left = `M${String(centerX - EYE_HALF_WIDTH)} ${String(EYE_Y)}`;
    const control = `Q${String(centerX)} ${String(EYE_Y - EYE_BULGE)} ${String(centerX + EYE_HALF_WIDTH)} ${String(EYE_Y)}`;

    return `${left} ${control}`;
}

// A four-point sparkle centered on the eye.
function sparkle(centerX: number): string {
    const top = `M${String(centerX)} ${String(EYE_Y - SPARKLE_RADIUS)}`;
    const toRight = `Q${String(centerX)} ${String(EYE_Y)} ${String(centerX + SPARKLE_RADIUS)} ${String(EYE_Y)}`;
    const toBottom = `Q${String(centerX)} ${String(EYE_Y)} ${String(centerX)} ${String(EYE_Y + SPARKLE_RADIUS)}`;
    const toLeft = `Q${String(centerX)} ${String(EYE_Y)} ${String(centerX - SPARKLE_RADIUS)} ${String(EYE_Y)}`;
    const toTop = `Q${String(centerX)} ${String(EYE_Y)} ${String(centerX)} ${String(EYE_Y - SPARKLE_RADIUS)} Z`;

    return [top, toRight, toBottom, toLeft, toTop].join(' ');
}

// The face of each state. The eyes go in a group of their own, so a blink or a pointer offset moves them alone.
// Filled parts set stroke to none, so the white outline from the svg defaults does not draw around them.
function renderFace(state: MascotState): ReactElement {
    switch (state) {
        case 'idle':
            return (
                <g stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round">
                    <path d={smileArc(LEFT_EYE_X)} />
                    <path d={smileArc(RIGHT_EYE_X)} />
                </g>
            );
        case 'typing':
            return (
                <g fill={WHITE} stroke="none">
                    <circle cx={LEFT_EYE_X} cy={EYE_Y} r={EYE_RADIUS} />
                    <circle cx={RIGHT_EYE_X} cy={EYE_Y} r={EYE_RADIUS} />
                </g>
            );
        case 'thinking':
            return (
                <g stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M43 61 L52 70 L43 79" />
                    <path d="M97 61 L88 70 L97 79" />
                </g>
            );
        case 'done':
            return (
                <g fill={WHITE} stroke="none">
                    <path d={sparkle(LEFT_EYE_X)} />
                    <path d={sparkle(RIGHT_EYE_X)} />
                </g>
            );
        case 'waiting':
            return (
                <g>
                    <circle cx={LEFT_EYE_X} cy={EYE_Y} r={EYE_RADIUS} fill={WHITE} stroke="none" />
                    <path d={smileArc(RIGHT_EYE_X)} stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round" />
                </g>
            );
        case 'sleepy':
            return (
                <g stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round">
                    <path d={`M45 ${String(EYE_Y)} H59`} />
                    <path d={`M81 ${String(EYE_Y)} H95`} />
                </g>
            );
        case 'error':
            return (
                <g stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round">
                    <path d="M44 62 L60 78 M60 62 L44 78" />
                    <path d="M80 62 L96 78 M96 62 L80 78" />
                </g>
            );
    }
}

// The eyes of these faces follow the pointer. Only round or arc eyes do, and only while the bot is idle or typing.
function isPointerFace(state: MascotState): boolean {
    return state === 'idle' || state === 'typing';
}

// Offsets are kept to a tenth of a unit, so a pointer that has not moved much causes no new render.
function roundOffset(value: number): number {
    return Math.round(value * 10) / 10;
}

// A random pause before the next blink, between the minimum and maximum delay.
function pickBlinkDelayMs(randomValue: number): number {
    return BLINK_MIN_DELAY_MS + randomValue * (BLINK_MAX_DELAY_MS - BLINK_MIN_DELAY_MS);
}

function CloudMascot({ color, shape, state, size = DEFAULT_SIZE }: CloudMascotProps): ReactElement {
    const svgRef = useRef<SVGSVGElement>(null);
    const [eyeOffset, setEyeOffset] = useState<Point>({ x: 0, y: 0 });
    const [isBlinking, setIsBlinking] = useState(false);
    // A long chat holds many mascots. Only the ones on screen listen to the pointer and run a blink timer.
    const [isOnScreen, setIsOnScreen] = useState(true);
    // The eyes move and blink under reduced motion too. The stylesheet only drops the easing there.
    const hasMovingEyes = isPointerFace(state);
    const isLooking = hasMovingEyes && isOnScreen;
    const isBlinkShown = hasMovingEyes && isBlinking;
    const body = BODY_SPECS[shape];
    const fill = MASCOT_COLORS[readMascotColor(color)];

    useEffect(() => {
        const element = svgRef.current;

        if (element === null || typeof IntersectionObserver === 'undefined') {
            return undefined;
        }

        const observer = new IntersectionObserver((entries) => {
            const latestEntry = entries.at(-1);

            if (latestEntry !== undefined) {
                setIsOnScreen(latestEntry.isIntersecting);
            }
        });

        observer.observe(element);

        return () => {
            observer.disconnect();
        };
    }, []);

    // One shared listener serves every mascot. Each one turns the pointer into its own eye offset.
    // While the owner types, the eyes follow the caret along the text box, through the shared typing listener.
    useEffect(() => {
        if (!isLooking) {
            return undefined;
        }

        const applyOffset = (offset: Point): void => {
            const rounded = { x: roundOffset(offset.x), y: roundOffset(offset.y) };

            setEyeOffset((previous) => {
                const isSame = previous.x === rounded.x && previous.y === rounded.y;

                return isSame ? previous : rounded;
            });
        };

        const lookAt = (point: Point): void => {
            const element = svgRef.current;

            if (element === null) {
                return;
            }

            const rect = element.getBoundingClientRect();
            const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

            const pointerOffset = computeEyeOffset(center, point, EYE_MAX_OFFSET);

            applyOffset(pointerOffset);
        };

        const stopListening = state === 'typing'
            ? subscribeToTyping((caretFraction) => {
                    const typingOffset = computeTypingEyeOffset(caretFraction, EYE_MAX_OFFSET, TYPING_LOOK_DOWN);

                    applyOffset(typingOffset);
                })
            : subscribeToPointer(lookAt);

        return () => {
            stopListening();
            // Leaving the look resets the eyes to the middle, so they do not stay turned after the owner stops typing.
            setEyeOffset(previous => (previous.x === 0 && previous.y === 0 ? previous : NO_EYE_OFFSET));
        };
    }, [isLooking, state]);

    // A blink after a random pause. No timer runs while the tab is hidden, and the next blink waits until it shows again.
    useEffect(() => {
        if (!isLooking) {
            return undefined;
        }

        let timer: number | undefined;

        const stopBlinking = (): void => {
            if (timer !== undefined) {
                window.clearTimeout(timer);
                timer = undefined;
            }

            setIsBlinking(false);
        };

        const scheduleBlink = (): void => {
            if (document.hidden) {
                return;
            }

            const randomValue = Math.random();
            const pauseMs = pickBlinkDelayMs(randomValue);

            timer = window.setTimeout(() => {
                setIsBlinking(true);

                timer = window.setTimeout(() => {
                    setIsBlinking(false);
                    scheduleBlink();
                }, BLINK_DURATION_MS);
            }, pauseMs);
        };

        const handleVisibilityChange = (): void => {
            stopBlinking();
            scheduleBlink();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        scheduleBlink();

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            stopBlinking();
        };
    }, [isLooking]);

    const eyeTransform = hasMovingEyes
        ? `translate(${String(eyeOffset.x)}px, ${String(eyeOffset.y)}px)`
        : undefined;
    const lookShiftX = roundOffset(eyeOffset.x * LOOK_SHIFT_PER_UNIT);
    const lookShiftY = roundOffset(eyeOffset.y * LOOK_SHIFT_PER_UNIT);
    const lookTilt = roundOffset(eyeOffset.x * LOOK_TILT_DEG_PER_UNIT);
    const lookTransform = hasMovingEyes
        ? `translate(${String(lookShiftX)}px, ${String(lookShiftY)}px) rotate(${String(lookTilt)}deg)`
        : undefined;

    return (
        <span className={`cloud-mascot is-${state}`} data-state={state} data-shape={shape} style={{ width: size, height: size }}>
            <svg ref={svgRef} viewBox={VIEW_BOX} aria-hidden="true" focusable="false">
                <g className="cloud-look" style={{ transform: lookTransform }}>
                    <g className="cloud-body" fill={fill} stroke="none">
                        {body.circles.map(circle => (
                            <circle key={`${String(circle.cx)}-${String(circle.cy)}`} cx={circle.cx} cy={circle.cy} r={circle.r} />
                        ))}
                        <rect x={body.base.x} y={body.base.y} width={body.base.width} height={body.base.height} rx={body.base.rx} />
                        {body.dot === undefined ? null : <circle cx={body.dot.cx} cy={body.dot.cy} r={body.dot.r} />}
                    </g>
                    <g className="cloud-face" data-face={state} data-tracks-pointer={hasMovingEyes ? 'true' : undefined}>
                        <g style={{ transform: eyeTransform }}>
                            <g className="cloud-eyes" data-blinking={isBlinkShown ? 'true' : undefined}>
                                {renderFace(state)}
                            </g>
                        </g>
                    </g>
                </g>
            </svg>
        </span>
    );
}

export { CloudMascot, pickBlinkDelayMs };
export type { CloudMascotProps };
