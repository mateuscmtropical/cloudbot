// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MASCOT_COLORS } from '../../shared/mascot.ts';
import type { MascotState } from '../mascotState.ts';
import { CloudMascot } from './CloudMascot.tsx';

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

    it('keeps 30 message mascots off the pointer, so a pointer move adds no listener and renders nothing', () => {
        setPrefersReducedMotion(false);

        const addListener = vi.spyOn(window, 'addEventListener');
        const onRender = vi.fn();
        const mascots = Array.from({ length: 30 }, (_value, index) => (
            <CloudMascot key={String(index)} color="blue" shape="puff" state="idle" size={28} tracksPointer={false} />
        ));

        render(<Profiler id="messages" onRender={onRender}>{mascots}</Profiler>);

        const rendersAfterMount = onRender.mock.calls.length;

        act(() => {
            window.dispatchEvent(new Event('pointermove'));
        });

        expect(addListener.mock.calls.some(call => call[0] === 'pointermove'))
            .toBe(false);
        expect(onRender.mock.calls.length)
            .toBe(rendersAfterMount);
        addListener.mockRestore();
    });

    it('does not follow the pointer when the owner prefers reduced motion', () => {
        setPrefersReducedMotion(true);

        const { container } = renderMascot('idle');

        expect(container.querySelector('.cloud-face')
            ?.getAttribute('data-tracks-pointer'))
            .toBeNull();
    });
});
