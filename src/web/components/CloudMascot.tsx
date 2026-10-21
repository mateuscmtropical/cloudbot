import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { MASCOT_COLORS } from '../../shared/mascot.ts';
import type { MascotColorName, MascotShape } from '../../shared/mascot.ts';
import { computeEyeOffset, subscribeToPointer } from '../mascotPointer.ts';
import type { Point } from '../mascotPointer.ts';
import type { MascotState } from '../mascotState.ts';

interface CloudMascotProps {
    color: MascotColorName;
    shape: MascotShape;
    state: MascotState;
    // Width and height in pixels. The cloud keeps its proportions.
    size?: number;
    // Whether the eyes may follow the pointer. Message mascots turn this off.
    tracksPointer?: boolean;
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
// How far the eyes may move toward the pointer, in viewBox units.
const EYE_MAX_OFFSET = 3;
const DEFAULT_SIZE = 40;

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
                <g className="cloud-blink" stroke={WHITE} fill="none" strokeWidth={FACE_STROKE_WIDTH} strokeLinecap="round">
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

function prefersReducedMotion(): boolean {
    if (typeof window.matchMedia !== 'function') {
        return false;
    }

    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Offsets are kept to a tenth of a unit, so a pointer that has not moved much causes no new render.
function roundOffset(value: number): number {
    return Math.round(value * 10) / 10;
}

function CloudMascot({ color, shape, state, size = DEFAULT_SIZE, tracksPointer = true }: CloudMascotProps): ReactElement {
    const svgRef = useRef<SVGSVGElement>(null);
    const [eyeOffset, setEyeOffset] = useState<Point>({ x: 0, y: 0 });
    // Read once per mount, not on every render.
    const [reducedMotion] = useState(prefersReducedMotion);
    const isTracking = tracksPointer && isPointerFace(state) && !reducedMotion;
    const body = BODY_SPECS[shape];
    const fill = MASCOT_COLORS[color];

    // One shared listener serves every mascot. Each one turns the pointer into its own eye offset.
    useEffect(() => {
        if (!isTracking) {
            return undefined;
        }

        return subscribeToPointer((point) => {
            const element = svgRef.current;

            if (element === null) {
                return;
            }

            const rect = element.getBoundingClientRect();
            const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

            const offset = computeEyeOffset(center, point, EYE_MAX_OFFSET);
            const rounded = { x: roundOffset(offset.x), y: roundOffset(offset.y) };

            setEyeOffset((previous) => {
                const isSame = previous.x === rounded.x && previous.y === rounded.y;

                return isSame ? previous : rounded;
            });
        });
    }, [isTracking]);

    const eyeTransform = isTracking
        ? `translate(${String(eyeOffset.x)}px, ${String(eyeOffset.y)}px)`
        : undefined;

    return (
        <span className={`cloud-mascot is-${state}`} data-state={state} data-shape={shape} style={{ width: size, height: size }}>
            <svg ref={svgRef} viewBox={VIEW_BOX} aria-hidden="true" focusable="false">
                <g className="cloud-body" fill={fill} stroke="none">
                    {body.circles.map(circle => (
                        <circle key={`${String(circle.cx)}-${String(circle.cy)}`} cx={circle.cx} cy={circle.cy} r={circle.r} />
                    ))}
                    <rect x={body.base.x} y={body.base.y} width={body.base.width} height={body.base.height} rx={body.base.rx} />
                    {body.dot === undefined ? null : <circle cx={body.dot.cx} cy={body.dot.cy} r={body.dot.r} />}
                </g>
                <g className="cloud-face" data-face={state} data-tracks-pointer={isTracking ? 'true' : undefined}>
                    <g style={{ transform: eyeTransform }}>
                        {renderFace(state)}
                    </g>
                </g>
            </svg>
        </span>
    );
}

export { CloudMascot };
export type { CloudMascotProps };
