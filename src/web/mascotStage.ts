import { findConversationMascot } from './mascotHop.ts';
import { BOLT, BUBBLE, FLAKE, HEART, NOTE, RAIN_LINE, STAR } from './mascotPiecePaths.ts';
import type { Point } from './mascotPointer.ts';

type TrickPieceKind = 'rain' | 'flake' | 'bolt' | 'note' | 'heart' | 'star' | 'puff';

// What a trick works with. The copy of the mascot starts at home, and its transforms are relative to that place.
// Everything moves by transform and opacity only, so the compositor runs it.
interface TrickStage {
    copy: HTMLElement;
    home: DOMRect;
    // The column of the chat. A trick stays over it unless it visits the chat list.
    main: DOMRect;
    // The mascots of the other bots on screen in the chat list. Empty on a phone, where the list is closed.
    others: HTMLElement[];
    pointer: Point | undefined;
    // Resolves when the animation ends, and stays pending once the trick is stopped, so the trick just goes no further.
    move: (element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => Promise<void>;
    pause: (durationMs: number) => Promise<void>;
    // A small drawing at a point of the screen, invisible until it is moved.
    spawn: (kind: TrickPieceKind, center: Point, size: number) => SVGSVGElement;
    // A thin line that hangs down from a point of the screen. Scale it on Y to grow it.
    spawnThread: (top: Point, height: number) => HTMLElement;
}

type MascotTrick = (stage: TrickStage) => Promise<void>;

interface TrickPlay {
    cancel: () => void;
    finished: Promise<void>;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const LONGEST_TRICK_MS = 30_000;
const PIECE_PATHS: Record<TrickPieceKind, string> = {
    rain: RAIN_LINE,
    flake: FLAKE,
    bolt: BOLT,
    note: NOTE,
    heart: HEART,
    star: STAR,
    puff: BUBBLE,
};

function isOnScreen(element: Element): boolean {
    const rect = element.getBoundingClientRect();

    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
}

// The list scrolls, so a mascot under its edge is out of sight even inside the window.
function isInsideList(element: Element): boolean {
    const list = element.closest('.bot-items');

    if (list === null) {
        return true;
    }

    const listRect = list.getBoundingClientRect();
    const rect = element.getBoundingClientRect();

    return rect.top >= listRect.top && rect.bottom <= listRect.bottom;
}

function findOtherMascots(): HTMLElement[] {
    const mascots = document.querySelectorAll<HTMLElement>('.bot-item:not(.is-selected) .cloud-mascot');

    return [...mascots].filter(mascot => isOnScreen(mascot) && isInsideList(mascot));
}

function makeCopy(source: HTMLElement, home: DOMRect): HTMLElement {
    const copy = source.cloneNode(true) as HTMLElement;
    const looks = copy.querySelectorAll<HTMLElement>('.cloud-look, .cloud-look g');

    // The copy does not follow the pointer, so it drops the look the mascot had.
    looks.forEach((look) => {
        look.style.removeProperty('transform');
    });
    copy.classList.add('mascot-trick-copy');
    copy.style.left = `${String(home.left)}px`;
    copy.style.top = `${String(home.top)}px`;
    copy.style.width = `${String(home.width)}px`;
    copy.style.height = `${String(home.height)}px`;

    return copy;
}

function makePiece(kind: TrickPieceKind, center: Point, size: number): SVGSVGElement {
    const piece = document.createElementNS(SVG_NAMESPACE, 'svg');
    const path = document.createElementNS(SVG_NAMESPACE, 'path');

    piece.classList.add('trick-piece');
    piece.dataset.kind = kind;
    piece.setAttribute('viewBox', '0 0 16 16');
    piece.style.left = `${String(center.x - size / 2)}px`;
    piece.style.top = `${String(center.y - size / 2)}px`;
    piece.style.width = `${String(size)}px`;
    piece.style.height = `${String(size)}px`;
    path.setAttribute('d', PIECE_PATHS[kind]);
    piece.append(path);

    return piece;
}

// Plays one trick with a copy of the mascot of the open chat, which stays hidden meanwhile. Returns undefined when it
// cannot play, such as with reduced motion or with no mascot on screen.
function playTrick(trick: MascotTrick, pointer?: Point): TrickPlay | undefined {
    const source = findConversationMascot(document);
    const prefersStillness = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (source === null || prefersStillness || !isOnScreen(source)) {
        return undefined;
    }

    const home = source.getBoundingClientRect();
    const mainElement = document.querySelector('.main-column') ?? document.documentElement;
    const layer = document.createElement('div');
    const copy = makeCopy(source, home);
    const animations = new Set<Animation>();
    let isStopped = false;

    layer.className = 'mascot-trick-layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.append(copy);

    const move: TrickStage['move'] = (element, keyframes, options) => new Promise((resolve) => {
        if (isStopped) {
            return;
        }

        const animation = element.animate(keyframes, { fill: 'forwards', ...options });

        animations.add(animation);
        animation.onfinish = () => {
            resolve();
        };
    });

    const stage: TrickStage = {
        copy,
        home,
        main: mainElement.getBoundingClientRect(),
        others: findOtherMascots(),
        pointer,
        move,
        pause: durationMs => move(layer, [], { duration: durationMs }),
        spawn: (kind, center, size) => {
            const piece = makePiece(kind, center, size);

            layer.append(piece);

            return piece;
        },
        spawnThread: (top, height) => {
            const thread = document.createElement('div');

            thread.className = 'trick-thread';
            thread.style.left = `${String(top.x)}px`;
            thread.style.top = `${String(top.y)}px`;
            thread.style.height = `${String(height)}px`;
            layer.append(thread);

            return thread;
        },
    };

    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });

    function stop(): void {
        if (isStopped) {
            return;
        }

        isStopped = true;
        window.clearTimeout(longestTimer);
        animations.forEach((animation) => {
            animation.cancel();
        });
        layer.remove();
        source?.removeAttribute('data-trick-away');
        finish();
    }

    // A trick that hangs, or a hidden tab that holds its animations, still gives the mascot back.
    const longestTimer = window.setTimeout(stop, LONGEST_TRICK_MS);

    document.body.append(layer);
    source.setAttribute('data-trick-away', 'true');
    trick(stage)
        .catch((error: unknown) => {
            console.error('A mascot trick failed', error);
        })
        .finally(stop);

    return { cancel: stop, finished };
}

export { findOtherMascots, playTrick };
export type { MascotTrick, TrickPieceKind, TrickPlay, TrickStage };
