import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import { GRID_COLUMNS, mosaicSpan, singleImageRatio } from '../attachmentLayout.ts';
import { Lightbox } from './Lightbox.tsx';

interface GridImage {
    url: string;
    name: string;
    width?: number | undefined;
    height?: number | undefined;
}

interface AttachmentGridProps {
    images: GridImage[];
}

interface AttachmentTileProps {
    image: GridImage;
    style: CSSProperties;
    onOpen: () => void;
}

const SINGLE_MAX_HEIGHT = 380;

// The space of a tile comes from its style, so the list does not move when the image loads.
function AttachmentTile({ image, style, onOpen }: AttachmentTileProps): ReactElement {
    const [isGone, setIsGone] = useState(false);

    if (isGone) {
        return <div className="attachment-tile attachment-tile-gone" style={style}>{`${image.name} is no longer available`}</div>;
    }

    return (
        <button type="button" className="attachment-tile" style={style} aria-label={`Open ${image.name}`} onClick={onOpen}>
            <img
                src={image.url}
                alt={image.name}
                loading="lazy"
                decoding="async"
                onError={() => {
                    setIsGone(true);
                }}
            />
        </button>
    );
}

// One image large, or several in a mosaic. Each opens in the lightbox.
function AttachmentGrid({ images }: AttachmentGridProps): ReactElement {
    const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
    const isSingle = images.length === 1;
    const singleRatio = singleImageRatio(images[0]?.width, images[0]?.height);
    const singleWidth = Math.round(SINGLE_MAX_HEIGHT * singleRatio);
    const gridStyle: CSSProperties | undefined = isSingle
        ? { width: `min(380px, 78vw, ${String(singleWidth)}px)` }
        : undefined;

    function tileStyle(index: number): CSSProperties {
        if (isSingle) {
            return { aspectRatio: singleRatio };
        }

        const span = mosaicSpan(index, images.length);

        return { gridColumn: `span ${String(span)}`, aspectRatio: span === GRID_COLUMNS ? 2 : 1 };
    }

    return (
        <div className={isSingle ? 'attachment-grid is-single' : 'attachment-grid'} style={gridStyle}>
            {images.map((image, index) => (
                <AttachmentTile
                    key={image.url}
                    image={image}
                    style={tileStyle(index)}
                    onOpen={() => {
                        setOpenIndex(index);
                    }}
                />
            ))}
            {openIndex === undefined
                ? null
                : (
                        <Lightbox
                            images={images}
                            startIndex={openIndex}
                            onClose={() => {
                                setOpenIndex(undefined);
                            }}
                        />
                    )}
        </div>
    );
}

export { AttachmentGrid };
export type { AttachmentGridProps, GridImage };
