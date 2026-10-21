import { MASCOT_COLORS } from '../shared/mascot.ts';

// The browser tab icon: the cloud mascot in its default color, with its face. The shapes are copied from the cloud
// mascot, so the tab and the chat show the same cloud. The static file public/favicon.svg is the idle face with no dot.

// The viewBox is square, so the cloud sits in the middle of the tab icon.
const ICON_VIEW_BOX = { x: 9, y: -4, size: 124 };
const CLOUD_COLOR = MASCOT_COLORS.blue;
const FACE_COLOR = '#ffffff';
// Heavier than the mascot's face, so the eyes still read at 16px.
const FACE_STROKE_WIDTH = 11;
const DOT_COLOR = '#e5484d';
const DOT_CENTER = { x: 118, y: 14 };
const DOT_RING_RADIUS = 14;
const DOT_RADIUS = 11;
const EYE_Y = 70;
const LEFT_EYE_X = 52;
const RIGHT_EYE_X = 88;
const EYE_HALF_WIDTH = 9;
const EYE_BULGE = 10;
const ARC_SEGMENTS = 10;

// The faces the tab shows. Idle is the calm smile, thinking is the chevron face of the cloud mascot while a bot works.
type TabFace = 'idle' | 'thinking';

interface CircleShape {
    kind: 'circle';
    cx: number;
    cy: number;
    r: number;
    fill: string;
}

interface RectShape {
    kind: 'rect';
    x: number;
    y: number;
    width: number;
    height: number;
    rx: number;
    fill: string;
}

interface StrokeShape {
    kind: 'stroke';
    points: [number, number][];
    stroke: string;
    width: number;
}

type TabShape = CircleShape | RectShape | StrokeShape;

const CLOUD_SHAPES: TabShape[] = [
    { kind: 'circle', cx: 40, cy: 68, r: 30, fill: CLOUD_COLOR },
    { kind: 'circle', cx: 72, cy: 46, r: 36, fill: CLOUD_COLOR },
    { kind: 'circle', cx: 104, cy: 66, r: 28, fill: CLOUD_COLOR },
    { kind: 'rect', x: 12, y: 66, width: 118, height: 40, rx: 20, fill: CLOUD_COLOR },
];

// The smile of the idle face: a quadratic arc that bulges up, sampled into a short line.
function smilePoints(centerX: number): [number, number][] {
    const steps = Array.from({ length: ARC_SEGMENTS + 1 }, (_, step) => step);

    return steps.map((step): [number, number] => {
        const progress = step / ARC_SEGMENTS;
        const inverse = 1 - progress;
        const pointX = inverse * inverse * (centerX - EYE_HALF_WIDTH) + 2 * inverse * progress * centerX + progress * progress * (centerX + EYE_HALF_WIDTH);
        const pointY = inverse * inverse * EYE_Y + 2 * inverse * progress * (EYE_Y - EYE_BULGE) + progress * progress * EYE_Y;

        return [pointX, pointY];
    });
}

function faceShapes(face: TabFace): TabShape[] {
    if (face === 'thinking') {
        return [
            { kind: 'stroke', points: [[43, 61], [52, 70], [43, 79]], stroke: FACE_COLOR, width: FACE_STROKE_WIDTH },
            { kind: 'stroke', points: [[97, 61], [88, 70], [97, 79]], stroke: FACE_COLOR, width: FACE_STROKE_WIDTH },
        ];
    }

    return [
        { kind: 'stroke', points: smilePoints(LEFT_EYE_X), stroke: FACE_COLOR, width: FACE_STROKE_WIDTH },
        { kind: 'stroke', points: smilePoints(RIGHT_EYE_X), stroke: FACE_COLOR, width: FACE_STROKE_WIDTH },
    ];
}

// The unread dot sits at the top right. A white ring keeps it apart from the cloud and from a dark tab.
function dotShapes(): TabShape[] {
    return [
        { kind: 'circle', cx: DOT_CENTER.x, cy: DOT_CENTER.y, r: DOT_RING_RADIUS, fill: FACE_COLOR },
        { kind: 'circle', cx: DOT_CENTER.x, cy: DOT_CENTER.y, r: DOT_RADIUS, fill: DOT_COLOR },
    ];
}

// Every shape of the icon, in drawing order. public/favicon.svg is this list with the idle face.
function tabIconShapes(face: TabFace, hasDot: boolean): TabShape[] {
    const dot = hasDot ? dotShapes() : [];

    return [...CLOUD_SHAPES, ...faceShapes(face), ...dot];
}

function formatNumber(value: number): string {
    return String(Math.round(value * 100) / 100);
}

function shapeToSvg(shape: TabShape): string {
    if (shape.kind === 'circle') {
        return `<circle cx="${formatNumber(shape.cx)}" cy="${formatNumber(shape.cy)}" r="${formatNumber(shape.r)}" fill="${shape.fill}"/>`;
    }

    if (shape.kind === 'rect') {
        return `<rect x="${formatNumber(shape.x)}" y="${formatNumber(shape.y)}" width="${formatNumber(shape.width)}" height="${formatNumber(shape.height)}" rx="${formatNumber(shape.rx)}" fill="${shape.fill}"/>`;
    }

    const pairs = shape.points.map(([pointX, pointY]) => `${formatNumber(pointX)},${formatNumber(pointY)}`);
    const points = pairs.join(' ');

    return `<polyline points="${points}" fill="none" stroke="${shape.stroke}" stroke-width="${formatNumber(shape.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// The SVG of the tab icon. The idle face without a dot is the static favicon file.
function buildFaviconSvg(face: TabFace, hasDot: boolean): string {
    const { x, y, size } = ICON_VIEW_BOX;
    const body = tabIconShapes(face, hasDot)
        .map(shapeToSvg)
        .join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${String(x)} ${String(y)} ${String(size)} ${String(size)}">${body}</svg>`;
}

// The icon link of the page. It is the one with data-tab-icon in index.html.
const TAB_ICON_LINK_SELECTOR = 'link[data-tab-icon]';

interface TabIconState {
    // A turn of a bot is running, so the thinking face shows.
    isWorking: boolean;
    // A reply arrived while the tab was hidden, and the owner has not looked at the tab since.
    hasUnreadReply: boolean;
}

// Sets the tab icon for the state. The static file is used for the plain idle face, so nothing is built in that case.
function applyTabIcon(state: TabIconState): void {
    const link = document.querySelector<HTMLLinkElement>(TAB_ICON_LINK_SELECTOR);

    if (link === null) {
        return;
    }

    const face: TabFace = state.isWorking ? 'thinking' : 'idle';
    const isPlain = face === 'idle' && !state.hasUnreadReply;

    if (isPlain) {
        setLinkHref(link, '/favicon.svg');

        return;
    }

    const svg = buildFaviconSvg(face, state.hasUnreadReply);
    const encodedSvg = encodeURIComponent(svg);

    setLinkHref(link, `data:image/svg+xml,${encodedSvg}`);
}

function setLinkHref(link: HTMLLinkElement, href: string): void {
    if (link.getAttribute('href') !== href) {
        link.setAttribute('href', href);
    }
}

export { TAB_ICON_LINK_SELECTOR, applyTabIcon, buildFaviconSvg };
