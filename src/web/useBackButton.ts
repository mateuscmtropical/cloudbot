import { useEffect, useRef } from 'react';

// The open layers, newest last. The phone's back button closes only the newest one.
const openLayers: Array<() => void> = [];
const pops = { ignored: 0, isListening: false };

function handlePopState(): void {
    if (pops.ignored > 0) {
        pops.ignored -= 1;

        return;
    }

    const closeNewest = openLayers.pop();

    closeNewest?.();
}

// Chrome skips a history entry that was added without a tap when the back button is pressed. So a layer that opens
// by itself, such as the chat on start, adds its entry on the next tap.
function addEntryWhenAllowed(onAdded: () => void): () => void {
    const add = (): void => {
        window.history.pushState(window.history.state, '');
        onAdded();
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
function useBackButton(isOpen: boolean, close: () => void): void {
    const closeRef = useRef(close);

    useEffect(() => {
        closeRef.current = close;
    });

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        if (!pops.isListening) {
            window.addEventListener('popstate', handlePopState);
            pops.isListening = true;
        }

        const layer = (): void => {
            closeRef.current();
        };
        const stopWaiting = addEntryWhenAllowed(() => {
            openLayers.push(layer);
        });

        return () => {
            stopWaiting();

            const index = openLayers.indexOf(layer);

            if (index < 0) {
                return;
            }

            openLayers.splice(index, 1);
            pops.ignored += 1;
            window.history.back();
        };
    }, [isOpen]);
}

export { useBackButton };
