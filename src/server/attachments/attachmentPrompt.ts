import type { TurnImage, TurnImageMediaType } from '../agent/AgentRunner.ts';
import type { SavedUpload } from './saveUpload.ts';

// The Messages API rejects images over 5 MB, so larger images are listed as files only.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function isTurnImageMediaType(mimeType: string): mimeType is TurnImageMediaType {
    return mimeType === 'image/png'
        || mimeType === 'image/jpeg'
        || mimeType === 'image/gif'
        || mimeType === 'image/webp';
}

// Lists the saved files in the prompt, so the agent knows where to read them.
function describeAttachments(attachments: SavedUpload[]): string {
    if (attachments.length === 0) {
        return '';
    }

    const fileLines = attachments.map(upload => `- ${upload.absolutePath} (${upload.name}, ${upload.mimeType}, ${String(upload.sizeBytes)} bytes)`);

    return ['The user attached these files. Read them at these paths:', ...fileLines].join('\n');
}

// Images come from the bytes kept in memory at upload time. The disk is never read again,
// so a file swapped on disk cannot change what Claude sees.
function readTurnImages(attachments: SavedUpload[]): TurnImage[] {
    return attachments.flatMap(upload => (
        isTurnImageMediaType(upload.mimeType) && upload.sizeBytes <= MAX_IMAGE_BYTES
            ? [{ mediaType: upload.mimeType, data: upload.bytes.toString('base64') }]
            : []
    ));
}

export { describeAttachments, isTurnImageMediaType, readTurnImages };
