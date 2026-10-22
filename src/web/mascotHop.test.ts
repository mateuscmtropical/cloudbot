// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findLatestMessageMascot, startMascotHop } from './mascotHop.ts';
import type { MascotHopPoint } from './mascotHop.ts';

interface TestMediaQueryList {
    matches: boolean;
    media: string;
    onchange: null;
    addEventListener: () => void;
    removeEventListener: () => void;
    dispatchEvent: () => boolean;
}

interface MascotElements {
    appElement: HTMLElement;
    sidebarElement: HTMLElement;
    mainColumnElement: HTMLElement;
    sourceMascot: HTMLElement;
    targetMascot: HTMLElement;
}

const rowEdge: MascotHopPoint = { x: 180, y: 40 };
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

function setPrefersReducedMotion(prefersReducedMotion: boolean): void {
    const matchMedia = vi.fn((query: string): TestMediaQueryList => ({
        matches: prefersReducedMotion && query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
    }));

    Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: matchMedia });
}

function createMascots(): MascotElements {
    const appElement = document.createElement('div');

    appElement.className = 'app';
    const sidebarElement = document.createElement('aside');

    sidebarElement.className = 'bot-list';
    const sourceMascot = document.createElement('span');

    sourceMascot.className = 'cloud-mascot';
    const mainColumnElement = document.createElement('main');

    mainColumnElement.className = 'main-column';
    const conversationElement = document.createElement('section');

    conversationElement.className = 'conversation';
    const latestMascotMessage = document.createElement('div');

    latestMascotMessage.dataset.messageMascot = 'true';
    const targetMascot = document.createElement('span');

    targetMascot.className = 'cloud-mascot';
    sidebarElement.append(sourceMascot);
    latestMascotMessage.append(targetMascot);
    conversationElement.append(latestMascotMessage);
    mainColumnElement.append(conversationElement);
    appElement.append(sidebarElement, mainColumnElement);
    document.body.append(appElement);

    vi.spyOn(sidebarElement, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(0, 0, 240, 800));
    vi.spyOn(mainColumnElement, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(240, 0, 960, 800));
    vi.spyOn(sourceMascot, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(20, 24, 40, 40));
    vi.spyOn(targetMascot, 'getBoundingClientRect')
        .mockReturnValue(new DOMRect(360, 300, 28, 28));

    return { appElement, sidebarElement, mainColumnElement, sourceMascot, targetMascot };
}

function dispatchAnimationEnd(element: HTMLElement, animationName: string): void {
    const event = new Event('animationend') as AnimationEvent;

    Object.defineProperty(event, 'animationName', { value: animationName });
    element.dispatchEvent(event);
}

afterEach(() => {
    document.body.replaceChildren();

    if (originalMatchMedia === undefined) {
        Reflect.deleteProperty(window, 'matchMedia');
    } else {
        Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    }

    vi.restoreAllMocks();
});

describe('findLatestMessageMascot', () => {
    it('returns the mascot from the latest message that shows one', () => {
        const conversationElement = document.createElement('section');
        const earlierMascotMessage = document.createElement('div');
        const earlierMascot = document.createElement('span');
        const latestMascotMessage = document.createElement('div');
        const latestMascot = document.createElement('span');

        earlierMascotMessage.dataset.messageMascot = 'true';
        earlierMascot.className = 'cloud-mascot';
        latestMascotMessage.dataset.messageMascot = 'true';
        latestMascot.className = 'cloud-mascot';
        earlierMascotMessage.append(earlierMascot);
        latestMascotMessage.append(latestMascot);
        conversationElement.append(earlierMascotMessage, latestMascotMessage);

        const foundMascot = findLatestMessageMascot(conversationElement);

        expect(foundMascot)
            .toBe(latestMascot);
    });

    it('returns null when no message shows a mascot', () => {
        const conversationElement = document.createElement('section');

        const foundMascot = findLatestMessageMascot(conversationElement);

        expect(foundMascot)
            .toBeNull();
    });
});

describe('startMascotHop', () => {
    it('skips the flight when reduced motion is enabled', () => {
        setPrefersReducedMotion(true);
        const { sourceMascot, targetMascot } = createMascots();

        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);

        expect(flight)
            .toBeUndefined();
        expect(sourceMascot.style.visibility)
            .toBe('');
        expect(document.querySelector('.mascot-hop-copy'))
            .toBeNull();
    });

    it('skips the flight when the list and conversation are not side by side', () => {
        const { sidebarElement, mainColumnElement, sourceMascot, targetMascot } = createMascots();

        vi.spyOn(sidebarElement, 'getBoundingClientRect')
            .mockReturnValue(new DOMRect(0, 0, 720, 800));
        vi.spyOn(mainColumnElement, 'getBoundingClientRect')
            .mockReturnValue(new DOMRect(0, 0, 960, 800));

        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);

        expect(flight)
            .toBeUndefined();
        expect(document.querySelector('.mascot-hop-copy'))
            .toBeNull();
    });

    it('skips the flight when the latest message has no mascot target', () => {
        const { sourceMascot } = createMascots();

        const flight = startMascotHop(sourceMascot, null, rowEdge);

        expect(flight)
            .toBeUndefined();
        expect(document.querySelector('.mascot-hop-copy'))
            .toBeNull();
    });

    it('uses one fixed CSS animation and restores the mascots when it ends', () => {
        const { sourceMascot, targetMascot } = createMascots();

        sourceMascot.style.visibility = 'collapse';

        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);
        const floatingMascot = document.querySelector<HTMLElement>('.mascot-hop-copy');

        expect(flight)
            .toBeDefined();
        expect(floatingMascot?.style.position)
            .toBe('fixed');
        expect(floatingMascot?.style.pointerEvents)
            .toBe('none');
        expect(floatingMascot?.style.getPropertyValue('--mascot-hop-duration'))
            .toBe('780ms');
        expect(floatingMascot?.style.getPropertyValue('--mascot-hop-row-edge-x'))
            .toBe('140px');
        expect(sourceMascot.style.visibility)
            .toBe('hidden');
        expect(targetMascot.style.visibility)
            .toBe('hidden');

        if (floatingMascot === null) {
            return;
        }

        dispatchAnimationEnd(floatingMascot, 'mascot-hop');

        expect(document.querySelector('.mascot-hop-copy'))
            .toBeNull();
        expect(sourceMascot.style.visibility)
            .toBe('collapse');
        expect(targetMascot.style.visibility)
            .toBe('');
        flight?.cancel();
    });

    it('keeps the flight running through a programmatic conversation scroll', () => {
        const { sourceMascot, targetMascot } = createMascots();
        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);

        document.dispatchEvent(new Event('scroll'));

        expect(document.querySelector('.mascot-hop-copy'))
            .not.toBeNull();
        flight?.cancel();
    });

    it('cancels the flight when the owner scrolls with the mouse', () => {
        const { sourceMascot, targetMascot } = createMascots();
        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);

        document.dispatchEvent(new Event('wheel'));

        expect(sourceMascot.style.visibility)
            .toBe('');
        expect(targetMascot.style.visibility)
            .toBe('');
        expect(document.querySelector('.mascot-hop-copy'))
            .toBeNull();
        flight?.cancel();
    });

    it('keeps the animation duration under one second', () => {
        const { sourceMascot, targetMascot } = createMascots();
        const flight = startMascotHop(sourceMascot, targetMascot, rowEdge);
        const floatingMascot = document.querySelector<HTMLElement>('.mascot-hop-copy');
        const durationMilliseconds = Number.parseInt(floatingMascot?.style.getPropertyValue('--mascot-hop-duration') ?? '0', 10);

        expect(durationMilliseconds)
            .toBeLessThan(1000);
        flight?.cancel();
    });
});
