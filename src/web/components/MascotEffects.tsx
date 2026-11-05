import type { ReactElement } from 'react';

import type { MascotBolt, ShownWeather } from '../../shared/mascot.ts';
import type { MascotEffect } from '../mascotMood.ts';
import { BOLT, BUBBLE, FLAKE, RAIN_LINE, STAR } from '../mascotPiecePaths.ts';
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
const QUESTION = 'M4 5 A4 4 0 1 1 9 9 Q8 10 8 12 M8 15 V15.2';
const SUN_CORE = 'M8 4 A4 4 0 1 1 7.99 4 Z';
const SUN_RAYS = 'M8 0.5 V2.5 M8 13.5 V15.5 M0.5 8 H2.5 M13.5 8 H15.5 M2.7 2.7 L4.1 4.1 M11.9 11.9 L13.3 13.3 M13.3 2.7 L11.9 4.1 M4.1 11.9 L2.7 13.3';
const GUST = 'M1 6 H10 Q14 6 13 3 M1 11 H13';
const RAINBOW_OUTER = 'M1.5 15 A6.5 6.5 0 0 1 14.5 15';
const RAINBOW_MIDDLE = 'M3 15 A5 5 0 0 1 13 15';
const RAINBOW_INNER = 'M4.5 15 A3.5 3.5 0 0 1 11.5 15';

const RAIN_PIECES: EffectPiece[] = [
    { className: 'fx-rain fx-first', path: RAIN_LINE, left: 22, top: 74, width: 14 },
    { className: 'fx-rain fx-second', path: RAIN_LINE, left: 44, top: 76, width: 14 },
    { className: 'fx-rain fx-third', path: RAIN_LINE, left: 66, top: 74, width: 14 },
];

// Where the bolts start for each direction. The stylesheet moves them on from there.
const BOLT_PIECES: Record<MascotBolt, EffectPiece[]> = {
    down: [
        { className: 'fx-bolt fx-first', path: BOLT, left: 20, top: 76, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: 42, top: 82, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: 62, top: 76, width: 20, isFilled: true },
    ],
    up: [
        { className: 'fx-bolt fx-first', path: BOLT, left: 18, top: 6, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: 42, top: 0, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: 64, top: 6, width: 20, isFilled: true },
    ],
    left: [
        { className: 'fx-bolt fx-first', path: BOLT, left: -2, top: 28, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: -6, top: 48, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: -2, top: 66, width: 20, isFilled: true },
    ],
    right: [
        { className: 'fx-bolt fx-first', path: BOLT, left: 82, top: 28, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: 90, top: 48, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: 82, top: 66, width: 20, isFilled: true },
    ],
    around: [
        { className: 'fx-bolt fx-first', path: BOLT, left: 2, top: 52, width: 20, isFilled: true },
        { className: 'fx-bolt fx-second', path: BOLT, left: 42, top: 82, width: 16, isFilled: true },
        { className: 'fx-bolt fx-third', path: BOLT, left: 78, top: 52, width: 20, isFilled: true },
    ],
};

const WEATHER_PIECES: Record<Exclude<ShownWeather, 'lightning'>, EffectPiece[]> = {
    rain: RAIN_PIECES,
    snow: [
        { className: 'fx-snow fx-first', path: FLAKE, left: 18, top: 72, width: 16 },
        { className: 'fx-snow fx-second', path: FLAKE, left: 44, top: 76, width: 13 },
        { className: 'fx-snow fx-third', path: FLAKE, left: 68, top: 72, width: 16 },
    ],
    sun: [
        { className: 'fx-sun-rays', path: SUN_RAYS, left: 60, top: -14, width: 48 },
        { className: 'fx-sun-core', path: SUN_CORE, left: 60, top: -14, width: 48, isFilled: true },
    ],
    wind: [
        { className: 'fx-wind fx-first', path: GUST, left: -8, top: 22, width: 26 },
        { className: 'fx-wind fx-second', path: GUST, left: -12, top: 46, width: 22 },
        { className: 'fx-wind fx-third', path: GUST, left: -8, top: 68, width: 26 },
    ],
    bubbles: [
        { className: 'fx-bubble fx-first', path: BUBBLE, left: 26, top: 8, width: 14 },
        { className: 'fx-bubble fx-second', path: BUBBLE, left: 48, top: 2, width: 18 },
        { className: 'fx-bubble fx-third', path: BUBBLE, left: 68, top: 10, width: 12 },
    ],
    rainbow: [
        { className: 'fx-rainbow fx-first', path: RAINBOW_OUTER, left: 6, top: -30, width: 88 },
        { className: 'fx-rainbow fx-second', path: RAINBOW_MIDDLE, left: 6, top: -30, width: 88 },
        { className: 'fx-rainbow fx-third', path: RAINBOW_INNER, left: 6, top: -30, width: 88 },
    ],
};

const EFFECT_PIECES: Record<Exclude<MascotEffect, 'weather'>, EffectPiece[]> = {
    // The nod before sleep moves the cloud itself.
    dozing: [],
    sleeping: [
        { className: 'fx-z fx-first', path: LETTER_Z, left: 72, top: 4, width: 16 },
        { className: 'fx-z fx-second', path: LETTER_Z, left: 72, top: 4, width: 22 },
        { className: 'fx-z fx-third', path: LETTER_Z, left: 72, top: 4, width: 28 },
    ],
    storm: RAIN_PIECES,
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
    weather: ShownWeather;
    bolt: MascotBolt;
}

function readPieces({ effect, weather, bolt }: MascotEffectsProps): EffectPiece[] {
    if (effect !== 'weather') {
        return EFFECT_PIECES[effect];
    }

    return weather === 'lightning' ? BOLT_PIECES[bolt] : WEATHER_PIECES[weather];
}

// Each piece is a small svg of its own and moves only by transform and opacity, so the compositor runs it without a repaint.
function MascotEffects(props: MascotEffectsProps): ReactElement {
    const pieces = readPieces(props);

    return (
        <span className="mascot-effects" data-effect={props.effect} data-bolt={props.bolt} aria-hidden="true">
            {pieces.map(piece => (
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
