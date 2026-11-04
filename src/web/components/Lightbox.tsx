import { useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement } from 'react';

import { swipeStep } from '../attachmentLayout.ts';
import { Modal } from './Modal.tsx';
import { RoundButton } from './RoundButton.tsx';
import { BackIcon, ChevronIcon, CloseIcon, DownloadIcon } from './icons.tsx';

interface LightboxImage {
    url: string;
    name: string;
}

interface LightboxProps {
    images: LightboxImage[];
    startIndex: number;
    onClose: () => void;
}

interface PointerPoint {
    x: number;
    y: number;
}

function Lightbox({ images, startIndex, onClose }: LightboxProps): ReactElement {
    const pointerStartRef = useRef<PointerPoint | undefined>(undefined);
    const wasSwipeRef = useRef(false);
    const [index, setIndex] = useState(startIndex);
    const image = images[index] ?? images[0];
    const hasSeveral = images.length > 1;

    function step(delta: number): void {
        setIndex(current => (current + delta + images.length) % images.length);
    }

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'ArrowLeft') {
            step(-1);
        }

        if (event.key === 'ArrowRight') {
            step(1);
        }
    }

    function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
        pointerStartRef.current = { x: event.clientX, y: event.clientY };
        wasSwipeRef.current = false;
    }

    function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
        const start = pointerStartRef.current;

        if (start === undefined || !hasSeveral) {
            return;
        }

        const stepBy = swipeStep(event.clientX - start.x, event.clientY - start.y);

        pointerStartRef.current = undefined;
        wasSwipeRef.current = stepBy !== 0;

        if (stepBy !== 0) {
            step(stepBy);
        }
    }

    // A click on the dark area closes. The click that ends a swipe does not.
    function handleClick(event: MouseEvent<HTMLDivElement>): void {
        if (event.target === event.currentTarget && !wasSwipeRef.current) {
            onClose();
        }
    }

    return (
        <Modal className="lightbox" label={image?.name ?? 'Image'} onClose={onClose}>
            <div
                className="lightbox-stage"
                onClick={handleClick}
                onKeyDown={handleKeyDown}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
            >
                {image === undefined ? null : <img key={image.url} className="lightbox-image" src={image.url} alt={image.name} decoding="async" draggable={false} />}
                <div className="lightbox-bar">
                    <span className="lightbox-count">{hasSeveral ? `${String(index + 1)} / ${String(images.length)}` : ''}</span>
                    {image === undefined
                        ? null
                        : (
                                <a className="round-button round-button-default lightbox-download" href={image.url} download={image.name} aria-label={`Download ${image.name}`}>
                                    <DownloadIcon />
                                </a>
                            )}
                    <RoundButton label="Close" onClick={onClose}><CloseIcon /></RoundButton>
                </div>
                {hasSeveral
                    ? (
                            <>
                                <div className="lightbox-step is-previous">
                                    <RoundButton label="Previous image" onClick={() => { step(-1); }}><BackIcon /></RoundButton>
                                </div>
                                <div className="lightbox-step is-next">
                                    <RoundButton label="Next image" onClick={() => { step(1); }}><ChevronIcon /></RoundButton>
                                </div>
                            </>
                        )
                    : null}
            </div>
        </Modal>
    );
}

export { Lightbox };
export type { LightboxImage, LightboxProps };
