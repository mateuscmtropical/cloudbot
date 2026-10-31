import { useEffect, useRef } from 'react';

// The open layers, oldest first. Each one has its own history entry, and the entry keeps in its state how many layers
// were open there. A back press then closes the layers above that number. Reading the number, instead of counting
// pops, keeps the history and the layers in step.
// A browser picks the entry of history.back when it is called, and a pushState right after it is undone when the back
// lands. So a layer that closes does not go back at once. A layer that opens in the same tap takes over its entry, and
// only the entries left over are taken back, after the tap.
const openLayers: Array<() => void> = [];
const listening = { isOn: false };
const leftEntries = { count: 0 };

// The history entries of the app before any layer opened have no number, which reads as no layer.
function readLayerCount(state: unknown): number {
    if (typeof state !== 'object' || state === null) {
        return 0;
    }

    const layerCount = (state as Record<string, unknown>).cloudbotLayers;

    return typeof layerCount === 'number' ? layerCount : 0;
}

function handlePopState(event: PopStateEvent): void {
    const layerCount = readLayerCount(event.state);
    const closedLayers = openLayers.splice(layerCount);

    closedLayers.reverse()
        .forEach((close) => {
            close();
        });
}

// Goes back over the entries of closed layers that no new layer took over. It goes back only from an entry of a
// layer, so it never leaves the app.
function takeLeftEntriesBack(): void {
    if (leftEntries.count === 0) {
        return;
    }

    leftEntries.count = 0;

    const currentLayerCount = readLayerCount(window.history.state);
    const extraEntries = currentLayerCount - openLayers.length;

    if (extraEntries > 0) {
        window.history.go(-extraEntries);
    }
}

// Chrome skips a history entry that was added without a tap when the back button is pressed. So a layer that opens
// by itself, such as the chat on start, adds its entry on the next tap.
function addEntryWhenAllowed(layer: () => void): () => void {
    const add = (): void => {
        const currentState: unknown = window.history.state;
        const baseState = typeof currentState === 'object' && currentState !== null ? currentState : {};

        openLayers.push(layer);

        const nextState = { ...baseState, cloudbotLayers: openLayers.length };

        if (leftEntries.count > 0) {
            leftEntries.count -= 1;
            window.history.replaceState(nextState, '');

            return;
        }

        window.history.pushState(nextState, '');
    };

    // Older browsers have no userActivation, and they do not skip entries either.
    const activation = navigator.userActivation as UserActivation | undefined;

    if (activation === undefined || activation.isActive) {
        add();

        return () => undefined;
    }

    window.addEventListener('pointerdown', add, { once: true, capture: true });

    return () => {
        window.removeEventListener('pointerdown', add, { capture: true });
    };
}

// While isOpen is true, the back button of the phone or the browser calls close instead of leaving the page.
// A layer closed another way takes its history entry back, so the next back press reaches the layer below.
// It goes back only from an entry of a layer, so closing a layer never leaves the app.
function useBackButton(isOpen: boolean, close: () => void): void {
    const closeRef = useRef(close);

    useEffect(() => {
        closeRef.current = close;
    });

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        if (!listening.isOn) {
            window.addEventListener('popstate', handlePopState);
            listening.isOn = true;
        }

        const layer = (): void => {
            closeRef.current();
        };
        const stopWaiting = addEntryWhenAllowed(layer);

        return () => {
            stopWaiting();

            const index = openLayers.indexOf(layer);

            if (index < 0) {
                return;
            }

            openLayers.splice(index, 1);
            leftEntries.count += 1;
            queueMicrotask(takeLeftEntriesBack);
        };
    }, [isOpen]);
}

export { useBackButton };
