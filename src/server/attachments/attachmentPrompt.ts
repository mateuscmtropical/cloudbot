import type { TurnImage, TurnImageMediaType } from '../agent/AgentRunner.ts';
import { readImageSize } from './readImageSize.ts';
import type { SavedUpload } from './saveUpload.ts';

// The Messages API rejects images over 5 MB, so larger images are listed as files only.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The Messages API accepts at most 8000 x 8000 pixels per image. Source:
// https://platform.claude.com/docs/build-with-claude/vision (image size limits).
// Larger images are listed as files only.
const MAX_IMAGE_SIDE_PIXELS = 8000;

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

// A whole image with a readable header and a side within the pixel limit.
function isSendableImage(upload: SavedUpload): boolean {
    const size = readImageSize(upload.bytes, upload.mimeType);

    return size !== undefined
        && size.width > 0
        && size.height > 0
        && size.width <= MAX_IMAGE_SIDE_PIXELS
        && size.height <= MAX_IMAGE_SIDE_PIXELS;
}

// Images come from the bytes kept in memory at upload time. The disk is never read again,
// so a file swapped on disk cannot change what Claude sees.
// A file that fails the check is still listed by path, it just does not become an image block.
function readTurnImages(attachments: SavedUpload[]): TurnImage[] {
    return attachments.flatMap(upload => (
        isTurnImageMediaType(upload.mimeType) && upload.sizeBytes <= MAX_IMAGE_BYTES && isSendableImage(upload)
            ? [{ mediaType: upload.mimeType, data: upload.bytes.toString('base64') }]
            : []
    ));
}

export { describeAttachments, isTurnImageMediaType, readTurnImages };
