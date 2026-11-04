import type { ReactElement } from 'react';

import type { MascotEffect } from '../mascotMood.ts';
import './mascotEffects.css';

// One drawn piece of an effect. Its place is in percent of the mascot and its motion comes from its class.
interface EffectPiece {
    className: string;
    path: string;
    left: number;
    top: number;
    width: number;
    isFilled?: boolean;
}

const LETTER_Z = 'M3 3 H13 L3 13 H13';
const BOLT = 'M9 0 L2 9 H7 L5 16 L13 6 H8 Z';
const DROP = 'M8 1 C11 6 13 8 13 11 A5 5 0 0 1 3 11 C3 8 5 6 8 1 Z';
const RAIN_LINE = 'M8 2 L6 14';
const QUESTION = 'M4 5 A4 4 0 1 1 9 9 Q8 10 8 12 M8 15 V15.2';
const STAR = 'M8 0 Q8 8 16 8 Q8 8 8 16 Q8 8 0 8 Q8 8 8 0 Z';

const EFFECT_PIECES: Record<MascotEffect, EffectPiece[]> = {
    sleeping: [
        { className: 'fx-z fx-first', path: LETTER_Z, left: 72, top: 4, width: 16 },
        { className: 'fx-z fx-second', path: LETTER_Z, left: 72, top: 4, width: 22 },
        { className: 'fx-z fx-third', path: LETTER_Z, left: 72, top: 4, width: 28 },
    ],
    cold: [
        { className: 'fx-drop', path: DROP, left: 44, top: 66, width: 12, isFilled: true },
        { className: 'fx-bolt fx-first', path: BOLT, left: 2, top: 52, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: 40, top: 70, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: 78, top: 52, width: 20, isFilled: true },
    ],
    storm: [
        { className: 'fx-rain fx-first', path: RAIN_LINE, left: 22, top: 74, width: 14 },
        { className: 'fx-rain fx-second', path: RAIN_LINE, left: 44, top: 76, width: 14 },
        { className: 'fx-rain fx-third', path: RAIN_LINE, left: 66, top: 74, width: 14 },
    ],
    question: [
        { className: 'fx-question', path: QUESTION, left: 72, top: -4, width: 26 },
    ],
    cheer: [
        { className: 'fx-star fx-first', path: STAR, left: 4, top: 4, width: 20, isFilled: true },
        { className: 'fx-star fx-second', path: STAR, left: 76, top: 0, width: 24, isFilled: true },
        { className: 'fx-star fx-third', path: STAR, left: 84, top: 56, width: 16, isFilled: true },
    ],
};

interface MascotEffectsProps {
    effect: MascotEffect;
}

// Each piece is a small svg of its own and moves only by transform and opacity, so the compositor runs it without a repaint.
function MascotEffects({ effect }: MascotEffectsProps): ReactElement {
    return (
        <span className="mascot-effects" data-effect={effect} aria-hidden="true">
            {EFFECT_PIECES[effect].map(piece => (
                <svg
                    key={piece.className}
                    className={`mascot-fx ${piece.className}`}
                    viewBox="0 0 16 16"
                    focusable="false"
                    style={{ left: `${String(piece.left)}%`, top: `${String(piece.top)}%`, width: `${String(piece.width)}%` }}
                >
                    <path d={piece.path} className={piece.isFilled === true ? 'is-filled' : 'is-line'} />
                </svg>
            ))}
        </span>
    );
}

export { MascotEffects };
export type { MascotEffectsProps };
