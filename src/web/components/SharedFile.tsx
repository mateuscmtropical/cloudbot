import type { ReactElement } from 'react';

import type { FileBody } from '../../shared/chatTypes.ts';
import { PREVIEW_IMAGE_TYPES } from '../../shared/previewImageTypes.ts';
import { AttachmentGrid } from './AttachmentGrid.tsx';
import { FileCard } from './FileCard.tsx';

// Larger images keep only the download card. The rest load only when they scroll into view.
const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;

interface SharedFileProps {
    file: FileBody;
    url: string;
}

// A file a bot sent, such as an image it made. An image shows in the chat, with its download card below.
function SharedFile({ file, url }: SharedFileProps): ReactElement {
    const showsImage = PREVIEW_IMAGE_TYPES.has(file.mimeType) && file.sizeBytes <= MAX_PREVIEW_BYTES;

    return (
        <div className="shared-file">
            {showsImage ? <AttachmentGrid images={[{ url, name: file.name, width: file.width, height: file.height }]} /> : null}
            <FileCard name={file.name} sizeBytes={file.sizeBytes} href={url} />
        </div>
    );
}

export { SharedFile };
export type { SharedFileProps };
