import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { Readable } from 'node:stream';

import type { Context } from 'hono';

import { PREVIEW_IMAGE_TYPES } from '../../shared/previewImageTypes.ts';

interface StoredFileInfo {
    name: string;
    mimeType: string;
    sizeBytes: number;
}

interface StoredFileOnDisk extends StoredFileInfo {
    absolutePath: string;
}

// A stored copy never changes, so the browser keeps it and a remounted image does not download again.
const STORED_FILE_CACHE = 'private, max-age=604800, immutable';

// RFC 5987 leaves out the characters that encodeURIComponent keeps.
function encodeHeaderFileName(name: string): string {
    const encodedName = encodeURIComponent(name);

    return encodedName.replaceAll(/['()*!]/g, character => `%${character.charCodeAt(0)
        .toString(16)
        .toUpperCase()}`);
}

// Only the raster image types open in the browser. Every other type is a download, and nosniff stops a browser from guessing.
function setStoredFileHeaders(context: Context, file: StoredFileInfo): void {
    const encodedName = encodeHeaderFileName(file.name);
    const fallbackName = file.name.replaceAll(/[^\x20-\x7E]|["\\%]/g, '_');
    const disposition = PREVIEW_IMAGE_TYPES.has(file.mimeType) ? 'inline' : 'attachment';
    const lengthText = String(file.sizeBytes);

    context.header('content-type', file.mimeType);
    context.header('content-length', lengthText);
    context.header('content-disposition', `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`);
    context.header('x-content-type-options', 'nosniff');
    context.header('cache-control', STORED_FILE_CACHE);
}

// Returns undefined when the copy is gone, so the route can answer 404.
async function respondWithStoredFile(context: Context, file: StoredFileOnDisk): Promise<Response | undefined> {
    const fileStream = createReadStream(file.absolutePath);

    // An error such as a missing copy ends the stream before any byte.
    try {
        await once(fileStream, 'open');
    } catch {
        return undefined;
    }

    setStoredFileHeaders(context, file);

    return context.body(Readable.toWeb(fileStream) as ReadableStream);
}

export { respondWithStoredFile, setStoredFileHeaders };
