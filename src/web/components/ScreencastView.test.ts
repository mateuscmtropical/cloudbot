import { describe, expect, it } from 'vitest';

import { buildKeyInput, buildPointerInput, buildResizeInput, buildSocketUrl, buildWheelInput, isShortcutHeld, parseFrame, pictureRect } from './ScreencastView.tsx';
import type { ScreencastFrame } from './ScreencastView.tsx';

const FRAME: ScreencastFrame = { data: 'AAAA', width: 1280, height: 800 };
// The picture is drawn at half the page size, at the top left of the window.
const PICTURE_RECT = { left: 100, top: 50, width: 640, height: 400 };

describe('buildSocketUrl', () => {
    it('uses the screencast path with the scheme of the page', () => {
        expect(buildSocketUrl({ protocol: 'https:', host: 'bot.example' } as Location))
            .toBe('wss://bot.example/api/desktop/screencast');
        expect(buildSocketUrl({ protocol: 'http:', host: 'localhost:3000' } as Location))
            .toBe('ws://localhost:3000/api/desktop/screencast');
    });
});

describe('parseFrame', () => {
    it('reads a frame message', () => {
        const message = JSON.stringify({ type: 'frame', data: 'AAAA', width: 1280, height: 800 });

        expect(parseFrame(message))
            .toEqual(FRAME);
    });

    it('ignores anything that is not a frame', () => {
        expect(parseFrame('not json'))
            .toBeUndefined();
        expect(parseFrame(JSON.stringify({ type: 'other' })))
            .toBeUndefined();
        expect(parseFrame(new ArrayBuffer(4)))
            .toBeUndefined();
    });
});

describe('buildPointerInput', () => {
    it('maps a point of the picture to the page pixels', () => {
        expect(buildPointerInput('down', 100 + 320, 50 + 200, PICTURE_RECT, FRAME))
            .toEqual({ type: 'mouse', kind: 'down', x: 640, y: 400 });
    });

    it('keeps the point inside the page', () => {
        expect(buildPointerInput('move', 5000, -20, PICTURE_RECT, FRAME))
            .toEqual({ type: 'mouse', kind: 'move', x: 1280, y: 0 });
    });

    it('sends nothing for a picture with no size', () => {
        expect(buildPointerInput('up', 10, 10, { left: 0, top: 0, width: 0, height: 0 }, FRAME))
            .toBeUndefined();
    });
});

describe('buildResizeInput', () => {
    it('uses the panel size on a phone and the normal size on a wide screen', () => {
        expect(buildResizeInput(390, 680, true))
            .toEqual({ type: 'resize', width: 390, height: 680 });
        expect(buildResizeInput(1200, 700, false))
            .toEqual({ type: 'resize', width: 1280, height: 800 });
    });

    it('bounds portrait sizes and waits for a visible panel', () => {
        expect(buildResizeInput(200, 2500, true))
            .toEqual({ type: 'resize', width: 240, height: 1920 });
        expect(buildResizeInput(0, 0, true))
            .toBeUndefined();
    });
});

describe('pictureRect', () => {
    it('finds the picture inside a box with bars, so a click maps to the page', () => {
        const picture = pictureRect({ left: 0, top: 0, width: 1000, height: 1000 }, FRAME);

        expect(picture.left)
            .toBe(0);
        expect(picture.top)
            .toBe(187.5);
        expect(picture.width)
            .toBe(1000);
        expect(picture.height)
            .toBe(625);
        expect(buildPointerInput('down', 0, 187.5, picture, FRAME))
            .toEqual({ type: 'mouse', kind: 'down', x: 0, y: 0 });
    });
});

describe('buildWheelInput', () => {
    it('clamps the scroll to what the server accepts', () => {
        expect(buildWheelInput(100, 50, 99_999, PICTURE_RECT, FRAME))
            .toEqual({ type: 'wheel', x: 0, y: 0, deltaY: 5000 });
    });
});

describe('buildKeyInput', () => {
    it('sends a named key as a key', () => {
        expect(buildKeyInput('Enter', false))
            .toEqual({ type: 'key', key: 'Enter' });
    });

    it('sends a printable character as text', () => {
        expect(buildKeyInput('a', false))
            .toEqual({ type: 'text', text: 'a' });
    });

    it('sends nothing for a printable character with a shortcut key held', () => {
        expect(buildKeyInput('c', true))
            .toBeUndefined();
    });

    it('sends nothing for a key the server does not take', () => {
        expect(buildKeyInput('F5', false))
            .toBeUndefined();
    });
});

describe('isShortcutHeld', () => {
    it('does not count AltGr, which is Ctrl and Alt together, as a shortcut', () => {
        expect(isShortcutHeld({ ctrlKey: true, altKey: true, metaKey: false, altGraph: false }, false))
            .toBe(false);
    });

    it('does not count the AltGraph state as a shortcut', () => {
        expect(isShortcutHeld({ ctrlKey: false, altKey: false, metaKey: false, altGraph: true }, false))
            .toBe(false);
    });

    it('counts Ctrl alone, Alt alone and Meta as shortcuts off macOS', () => {
        expect(isShortcutHeld({ ctrlKey: true, altKey: false, metaKey: false, altGraph: false }, false))
            .toBe(true);
        expect(isShortcutHeld({ ctrlKey: false, altKey: true, metaKey: false, altGraph: false }, false))
            .toBe(true);
        expect(isShortcutHeld({ ctrlKey: false, altKey: false, metaKey: true, altGraph: false }, false))
            .toBe(true);
    });

    it('does not count Option alone as a shortcut on macOS, because it types characters', () => {
        expect(isShortcutHeld({ ctrlKey: false, altKey: true, metaKey: false, altGraph: false }, true))
            .toBe(false);
    });

    it('still counts Command and Control as shortcuts on macOS', () => {
        expect(isShortcutHeld({ ctrlKey: false, altKey: false, metaKey: true, altGraph: false }, true))
            .toBe(true);
        expect(isShortcutHeld({ ctrlKey: true, altKey: false, metaKey: false, altGraph: false }, true))
            .toBe(true);
    });
});
