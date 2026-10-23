type MascotFace = 'idle' | 'sleepy' | 'thinking' | 'error';

interface CircleSpec {
    cx: number;
    cy: number;
    r: number;
}

// The blue puff of the app, drawn as a still SVG. The web app draws the same shape in CloudMascot.tsx.
const VIEW_BOX = '-10 -10 160 130';
const BODY_COLOR = '#1a7cff';
const BODY_CIRCLES: CircleSpec[] = [{ cx: 40, cy: 68, r: 30 }, { cx: 72, cy: 46, r: 36 }, { cx: 104, cy: 66, r: 28 }];
const BODY_BASE = '<rect x="12" y="66" width="118" height="40" rx="20"/>';
const FACE_STROKE = 'stroke="#fff" fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"';

const FACES: Record<MascotFace, string> = {
    idle: `<g class="eyes" ${FACE_STROKE}><path d="M43 70 Q52 60 61 70"/><path d="M79 70 Q88 60 97 70"/></g>`,
    sleepy: `<g ${FACE_STROKE}><path d="M45 70 H59"/><path d="M81 70 H95"/></g>`,
    thinking: `<g ${FACE_STROKE}><path d="M43 61 L52 70 L43 79"/><path d="M97 61 L88 70 L97 79"/></g>`,
    error: `<g ${FACE_STROKE}><path d="M44 62 L60 78 M60 62 L44 78"/><path d="M80 62 L96 78 M96 62 L80 78"/></g>`,
};

function renderBodyCircle(circle: CircleSpec): string {
    return `<circle cx="${String(circle.cx)}" cy="${String(circle.cy)}" r="${String(circle.r)}"/>`;
}

function renderMascot(face: MascotFace): string {
    const circles = BODY_CIRCLES.map(renderBodyCircle)
        .join('');

    return `<span class="mascot"><svg viewBox="${VIEW_BOX}" aria-hidden="true" focusable="false"><g fill="${BODY_COLOR}" stroke="none">${circles}${BODY_BASE}</g>${FACES[face]}</svg></span>`;
}

export { renderMascot };
export type { MascotFace };
