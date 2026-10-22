interface MascotHopPoint {
    x: number;
    y: number;
}

interface MascotHop {
    cancel: () => void;
}

interface MascotHopOffset {
    x: number;
    y: number;
    scale: number;
}

const MASCOT_HOP_DURATION_MS = 780;
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' ']);

function isSideBySide(sourceMascot: HTMLElement, targetMascot: HTMLElement): boolean {
    const appElement = sourceMascot.closest('.app');

    if (appElement === null || targetMascot.closest('.app') !== appElement) {
        return false;
    }

    const sidebarElement = appElement.querySelector<HTMLElement>('.bot-list');
    const mainColumnElement = appElement.querySelector<HTMLElement>('.main-column');

    if (sidebarElement === null || mainColumnElement === null) {
        return false;
    }

    const sidebarRect = sidebarElement.getBoundingClientRect();
    const mainColumnRect = mainColumnElement.getBoundingClientRect();
    const sourceRect = sourceMascot.getBoundingClientRect();

    return sidebarRect.width > 0
        && mainColumnRect.width > 0
        && sidebarRect.left >= 0
        && sidebarRect.right <= mainColumnRect.left
        && sourceRect.left >= sidebarRect.left
        && sourceRect.right <= sidebarRect.right;
}

function findLatestMessageMascot(conversationElement: ParentNode): HTMLElement | null {
    const mascotMessageNodes = conversationElement.querySelectorAll<HTMLElement>('[data-message-mascot="true"]');
    const mascotMessages = Array.from(mascotMessageNodes);
    const latestMascotMessage = mascotMessages.at(-1);

    return latestMascotMessage?.querySelector<HTMLElement>('.cloud-mascot') ?? null;
}

function setOffsetStyles(element: HTMLElement, name: string, offset: MascotHopOffset): void {
    const scale = offset.scale.toString();

    element.style.setProperty(`--mascot-hop-${name}-x`, `${offset.x.toString()}px`);
    element.style.setProperty(`--mascot-hop-${name}-y`, `${offset.y.toString()}px`);
    element.style.setProperty(`--mascot-hop-${name}-scale`, scale);
}

function interpolateOffset(start: MascotHopOffset, end: MascotHopOffset, share: number): MascotHopOffset {
    return {
        x: start.x + (end.x - start.x) * share,
        y: start.y + (end.y - start.y) * share,
        scale: start.scale + (end.scale - start.scale) * share,
    };
}

function startMascotHop(
    sourceMascot: HTMLElement | null,
    targetMascot: HTMLElement | null,
    rowEdge: MascotHopPoint,
): MascotHop | undefined {
    if (sourceMascot === null || targetMascot === null || !sourceMascot.isConnected || !targetMascot.isConnected) {
        return undefined;
    }

    const sourceElement = sourceMascot;
    const targetElement = targetMascot;

    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return undefined;
    }

    if (!isSideBySide(sourceElement, targetElement)) {
        return undefined;
    }

    const sourceRect = sourceElement.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();

    if (sourceRect.width <= 0 || sourceRect.height <= 0 || targetRect.width <= 0 || targetRect.height <= 0) {
        return undefined;
    }

    const sourceCenterX = sourceRect.left + sourceRect.width / 2;
    const sourceCenterY = sourceRect.top + sourceRect.height / 2;
    const targetCenterX = targetRect.left + targetRect.width / 2;
    const targetCenterY = targetRect.top + targetRect.height / 2;
    const rowEdgeOffset: MascotHopOffset = {
        x: rowEdge.x - sourceCenterX,
        y: rowEdge.y - sourceCenterY,
        scale: 1,
    };
    const landingOffset: MascotHopOffset = {
        x: targetCenterX - sourceCenterX,
        y: targetCenterY - sourceCenterY,
        scale: targetRect.width / sourceRect.width,
    };
    const firstRowHopOffset = interpolateOffset({ x: 0, y: 0, scale: 1 }, rowEdgeOffset, 1 / 3);
    const secondRowHopOffset = interpolateOffset({ x: 0, y: 0, scale: 1 }, rowEdgeOffset, 2 / 3);
    const landingMiddleOffset = interpolateOffset(rowEdgeOffset, landingOffset, 0.5);
    const sourceVisibility = sourceElement.style.visibility;
    const targetVisibility = targetElement.style.visibility;
    const floatingMascot = sourceElement.cloneNode(true) as HTMLElement;

    floatingMascot.classList.add('mascot-hop-copy');
    floatingMascot.setAttribute('aria-hidden', 'true');
    floatingMascot.setAttribute('inert', '');
    floatingMascot.style.position = 'fixed';
    floatingMascot.style.left = `${sourceRect.left.toString()}px`;
    floatingMascot.style.top = `${sourceRect.top.toString()}px`;
    floatingMascot.style.width = `${sourceRect.width.toString()}px`;
    floatingMascot.style.height = `${sourceRect.height.toString()}px`;
    floatingMascot.style.pointerEvents = 'none';
    floatingMascot.style.setProperty('--mascot-hop-duration', `${MASCOT_HOP_DURATION_MS.toString()}ms`);
    setOffsetStyles(floatingMascot, 'row-first', firstRowHopOffset);
    setOffsetStyles(floatingMascot, 'row-second', secondRowHopOffset);
    setOffsetStyles(floatingMascot, 'row-edge', rowEdgeOffset);
    setOffsetStyles(floatingMascot, 'landing-middle', landingMiddleOffset);
    setOffsetStyles(floatingMascot, 'landing', landingOffset);

    let isFinished = false;

    function handleKeydown(event: KeyboardEvent): void {
        const eventTarget = event.target;

        if (!SCROLL_KEYS.has(event.key)
            || !(eventTarget instanceof HTMLElement)
            || eventTarget.closest('input, textarea, [contenteditable="true"]') !== null) {
            return;
        }

        finishFlight();
    }

    function handleAnimationEnd(event: AnimationEvent): void {
        if (event.target === floatingMascot && event.animationName === 'mascot-hop') {
            finishFlight();
        }
    }

    function finishFlight(): void {
        if (isFinished) {
            return;
        }

        isFinished = true;
        window.clearTimeout(fallbackTimer);
        document.removeEventListener('wheel', finishFlight, true);
        document.removeEventListener('touchmove', finishFlight, true);
        document.removeEventListener('keydown', handleKeydown, true);
        floatingMascot.removeEventListener('animationend', handleAnimationEnd);
        floatingMascot.remove();
        sourceElement.style.visibility = sourceVisibility;
        targetElement.style.visibility = targetVisibility;
    }

    // A hidden tab or a missing stylesheet never sends animationend, so the flight also ends on a timer.
    const fallbackTimer = window.setTimeout(finishFlight, MASCOT_HOP_DURATION_MS + 500);

    floatingMascot.addEventListener('animationend', handleAnimationEnd);
    document.body.append(floatingMascot);
    sourceElement.style.visibility = 'hidden';
    targetElement.style.visibility = 'hidden';
    document.addEventListener('wheel', finishFlight, { capture: true, passive: true });
    document.addEventListener('touchmove', finishFlight, { capture: true, passive: true });
    document.addEventListener('keydown', handleKeydown, true);

    return { cancel: finishFlight };
}

export { findLatestMessageMascot, startMascotHop };
export type { MascotHop, MascotHopPoint };
