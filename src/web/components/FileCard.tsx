import type { ReactElement } from 'react';

import { formatFileSize } from '../formatFileSize.ts';
import { FileIcon } from './icons.tsx';

interface FileCardProps {
    name: string;
    sizeBytes: number;
    // With a link the card downloads the file.
    href?: string | undefined;
}

function FileCard({ name, sizeBytes, href }: FileCardProps): ReactElement {
    const content = (
        <>
            <span className="file-chip-icon"><FileIcon /></span>
            <span className="file-chip-text">
                <span className="file-chip-name" title={name}>{name}</span>
                <span className="file-size">{formatFileSize(sizeBytes)}</span>
            </span>
        </>
    );

    if (href === undefined) {
        return <div className="file-chip">{content}</div>;
    }

    return <a className="file-chip" href={href} download={name} aria-label={`Download ${name}`}>{content}</a>;
}

export { FileCard };
export type { FileCardProps };
