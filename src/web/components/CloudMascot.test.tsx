// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASCOT_COLORS } from '../../shared/mascot.ts';
import type { MascotState } from '../mascotState.ts';
import { CloudMascot, pickBlinkDelayMs } from './CloudMascot.tsx';

const ALL_STATES: MascotState[] = ['idle', 'typing', 'thinking', 'done', 'waiting', 'sleepy', 'error'];
const ALL_SHAPES = ['puff', 'tall', 'wide', 'bubble'] as const;

// Makes matchMedia answer the reduced motion query with the given value.
function setPrefersReducedMotion(prefers: boolean): void {
    const matchMedia = vi.fn((query: string) => ({
        matches: prefers && query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
    }));

    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMedia });
}

function renderMascot(state: MascotState, shape: (typeof ALL_SHAPES)[number] = 'puff', color: keyof typeof MASCOT_COLORS = 'blue'): RenderResult {
    return render(<CloudMascot color={color} shape={shape} state={state} />);
}

describe('CloudMascot', () => {
    afterEach(() => {
        cleanup();
        setPrefersReducedMotion(false);
    });

    it.each(ALL_STATES)('renders the %s state with its own face', (state) => {
        const { container } = renderMascot(state);
        const root = container.querySelector('.cloud-mascot');
        const face = container.querySelector('.cloud-face');

        expect(root?.getAttribute('data-state'))
            .toBe(state);
        expect(face?.getAttribute('data-face'))
            .toBe(state);
    });

    it('draws a different face for each state', () => {
        const faces = ALL_STATES.map((state) => {
            const { container, unmount } = renderMascot(state);
            const markup = container.querySelector('.cloud-face')?.innerHTML ?? '';

            unmount();

            return markup;
        });

        expect(new Set(faces).size)
            .toBe(ALL_STATES.length);
    });

    it('gives the working face round eyes that do not follow the pointer', () => {
        const { container } = renderMascot('working');

        expect(container.querySelectorAll('.cloud-eyes circle'))
            .toHaveLength(2);
        expect(container.querySelector('.cloud-face')
            ?.getAttribute('data-tracks-pointer'))
            .toBeNull();
    });

    it.each(ALL_SHAPES)('draws the %s body from circles and a flat base', (shape) => {
        const { container } = renderMascot('idle', shape);
        const body = container.querySelector('.cloud-body');

        expect(container.querySelector('.cloud-mascot')
            ?.getAttribute('data-shape'))
            .toBe(shape);
        expect(body?.querySelectorAll('circle').length)
            .toBeGreaterThanOrEqual(3);
        expect(body?.querySelectorAll('rect'))
            .toHaveLength(1);
    });

    it('draws the small floating dot only on the bubble body', () => {
        const bubble = renderMascot('idle', 'bubble').container.querySelector('.cloud-body');
        const puff = renderMascot('idle', 'puff').container.querySelector('.cloud-body');

        expect(bubble?.querySelectorAll('circle').length)
            .toBe(4);
        expect(puff?.querySelectorAll('circle').length)
            .toBe(3);
    });

    it('fills a stored color that the palette no longer has with blue, so the bot still shows', () => {
        const { container } = renderMascot('idle', 'puff', 'yellow' as never);

        expect(container.querySelector('.cloud-body')
            ?.getAttribute('fill'))
            .toBe(MASCOT_COLORS.blue);
    });

    it('fills the body with the color of the palette, and any color can show any face', () => {
        const { container } = renderMascot('done', 'wide', 'mint');

        expect(container.querySelector('.cloud-body')
            ?.getAttribute('fill'))
            .toBe(MASCOT_COLORS.mint);
        expect(container.querySelector('.cloud-face')
            ?.getAttribute('data-face'))
            .toBe('done');
    });

    it('uses the size it is given', () => {
        const { container } = render(<CloudMascot color="blue" shape="puff" state="idle" size={28} />);
        const root = container.querySelector<HTMLElement>('.cloud-mascot');

        expect(root?.style.width)
            .toBe('28px');
        expect(root?.style.height)
            .toBe('28px');
    });

    it('lets the idle face and the typing face follow the pointer, and no other face', () => {
        setPrefersReducedMotion(false);

        const idle = renderMascot('idle').container.querySelector('.cloud-face');
        const typing = renderMascot('typing').container.querySelector('.cloud-face');
        const thinking = renderMascot('thinking').container.querySelector('.cloud-face');

        expect(idle?.getAttribute('data-tracks-pointer'))
            .toBe('true');
        expect(typing?.getAttribute('data-tracks-pointer'))
            .toBe('true');
        expect(thinking?.getAttribute('data-tracks-pointer'))
            .toBeNull();
    });

    it('shares one pointer listener among 30 mascots', () => {
        setPrefersReducedMotion(false);

        const addListener = vi.spyOn(window, 'addEventListener');
        const mascots = Array.from({ length: 30 }, (_value, index) => (
            <CloudMascot key={String(index)} color="blue" shape="puff" state="idle" size={28} />
        ));

        render(<>{mascots}</>);

        const pointerMoveAdds = addListener.mock.calls.filter(call => call[0] === 'pointermove');

        expect(pointerMoveAdds)
            .toHaveLength(1);
        addListener.mockRestore();
    });

    it('stops listening to the pointer while it is off screen', () => {
        const visibility: { report?: (entries: IntersectionObserverEntry[]) => void } = {};

        class FakeIntersectionObserver {
            constructor(report: (entries: IntersectionObserverEntry[]) => void) {
                visibility.report = report;
            }

            observe(): void {}

            disconnect(): void {}
        }

        vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
        const removeListener = vi.spyOn(window, 'removeEventListener');

        renderMascot('idle');
        act(() => {
            const offScreenEntry = { isIntersecting: false } as IntersectionObserverEntry;

            visibility.report?.([offScreenEntry]);
        });

        const pointerMoveRemoves = removeListener.mock.calls.filter(call => call[0] === 'pointermove');

        expect(pointerMoveRemoves)
            .toHaveLength(1);
        removeListener.mockRestore();
        vi.unstubAllGlobals();
    });

    it('still follows the pointer when the owner prefers reduced motion', () => {
        setPrefersReducedMotion(true);

        const { container } = renderMascot('idle');

        expect(container.querySelector('.cloud-face')
            ?.getAttribute('data-tracks-pointer'))
            .toBe('true');
    });
});

// The blink starts after the pause, which is the minimum delay when Math.random returns 0.
const FIRST_BLINK_DELAY_MS = 2500;
const BLINK_DURATION_MS = 150;

function isBlinking(container: HTMLElement): boolean {
    return container.querySelector('.cloud-eyes')
        ?.getAttribute('data-blinking') === 'true';
}

describe('pickBlinkDelayMs', () => {
    it('picks a pause between 2.5 and 6 seconds', () => {
        expect(pickBlinkDelayMs(0))
            .toBe(2500);
        expect(pickBlinkDelayMs(1))
            .toBe(6000);
        expect(pickBlinkDelayMs(0.5))
            .toBe(4250);
    });
});

describe('CloudMascot blinking', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const randomSpy = vi.spyOn(Math, 'random');

        randomSpy.mockReturnValue(0);
        setPrefersReducedMotion(false);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
        setPrefersReducedMotion(false);
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    });

    it('blinks after a random pause and opens the eyes again', () => {
        const { container } = renderMascot('idle');

        act(() => {
            vi.advanceTimersByTime(FIRST_BLINK_DELAY_MS);
        });
        expect(isBlinking(container))
            .toBe(true);

        act(() => {
            vi.advanceTimersByTime(BLINK_DURATION_MS);
        });
        expect(isBlinking(container))
            .toBe(false);
    });

    it('does not blink on the faces that are not pointer faces', () => {
        const { container } = renderMascot('thinking');

        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(isBlinking(container))
            .toBe(false);
    });

    it('still blinks when the owner prefers reduced motion', () => {
        setPrefersReducedMotion(true);

        const { container } = renderMascot('idle');

        act(() => {
            vi.advanceTimersByTime(FIRST_BLINK_DELAY_MS);
        });
        expect(isBlinking(container))
            .toBe(true);
    });

    it('schedules no blink while the tab is hidden, and blinks again once it shows', () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });

        const { container } = renderMascot('idle');

        act(() => {
            vi.advanceTimersByTime(10_000);
        });
        expect(isBlinking(container))
            .toBe(false);

        Object.defineProperty(document, 'hidden', { configurable: true, value: false });

        act(() => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        act(() => {
            vi.advanceTimersByTime(FIRST_BLINK_DELAY_MS);
        });
        expect(isBlinking(container))
            .toBe(true);
    });
});

describe('CloudMascot while the owner types', () => {
    afterEach(() => {
        cleanup();
        setPrefersReducedMotion(false);
        document.body.innerHTML = '';
    });

    it('turns the eyes along the focused text box with the caret, and looks down at it', () => {
        setPrefersReducedMotion(false);
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue({ left: 100, top: 300, width: 200, height: 40, right: 300, bottom: 340, x: 100, y: 300, toJSON: () => ({}) });
        textarea.focus();

        const { container } = renderMascot('typing');
        const eyes = container.querySelector<SVGGElement>('.cloud-face > g');

        // Happy-dom has no layout, so the caret reads at the left edge: the eyes turn fully left and look down.
        expect(eyes?.style.transform)
            .toBe('translate(-9px, 6px)');
        // The whole cloud leans the same way a little, so the look reads on a small mascot too.
        expect(container.querySelector<SVGGElement>('.cloud-look')?.style.transform)
            .toBe('translate(-2.7px, 1.8px) rotate(-7.2deg)');
    });

    it('keeps the eyes on the text box and ignores the pointer while typing', () => {
        setPrefersReducedMotion(false);
        document.body.innerHTML = '<textarea id="composer"></textarea>';

        const textarea = document.getElementById('composer') as HTMLTextAreaElement;

        vi.spyOn(textarea, 'getBoundingClientRect')
            .mockReturnValue({ left: 100, top: 300, width: 200, height: 40, right: 300, bottom: 340, x: 100, y: 300, toJSON: () => ({}) });
        textarea.focus();

        const { container } = renderMascot('typing');
        const eyes = container.querySelector<SVGGElement>('.cloud-face > g');
        const transformBefore = eyes?.style.transform;

        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: -500, clientY: -500 }));
        });

        expect(eyes?.style.transform)
            .toBe(transformBefore);
    });
});
