import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

interface SavedUpload {
    id: string;
    name: string;
    absolutePath: string;
    mimeType: string;
    sizeBytes: number;
    bytes: Buffer;
}

interface UploadPlan {
    file: File;
    id: string;
    absolutePath: string;
}

const MAX_FILES_PER_UPLOAD = 10;
const MAX_DISPLAY_NAME_LENGTH = 120;
const DEFAULT_MIME_TYPE = 'application/octet-stream';
const DEFAULT_MAX_UPLOAD_MB = 20;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const UPLOAD_FILE_MODE = 0o640;
const UPLOAD_FOLDER_MODE = 0o2750;
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,10}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const JPEG_SIGNATURE = Buffer.from([0xFF, 0xD8, 0xFF]);

// Only the last path segment is kept, so a name like ../../etc/passwd becomes passwd.
// The cut counts code points, so an emoji is never split in half.
function cleanDisplayName(originalName: string): string {
    const segments = originalName.split(/[\\/]/);
    const lastSegment = segments[segments.length - 1] ?? '';
    const printableName = lastSegment
        .replaceAll(/\p{Cc}/gu, '')
        .trim();

    if (printableName === '' || printableName === '.' || printableName === '..') {
        return 'file';
    }

    const codePoints = Array.from(printableName);
    const shortName = codePoints.slice(0, MAX_DISPLAY_NAME_LENGTH);

    return shortName.join('');
}

// The stored name never comes from the client, so only a short, plain extension is kept.
function cleanExtension(originalName: string): string {
    const displayName = cleanDisplayName(originalName);
    const dotIndex = displayName.lastIndexOf('.');

    if (dotIndex <= 0) {
        return '';
    }

    const extension = displayName.slice(dotIndex)
        .toLowerCase();

    return EXTENSION_PATTERN.test(extension) ? extension : '';
}

function detectImageMimeType(header: Buffer): string | undefined {
    const pngPrefix = header.subarray(0, PNG_SIGNATURE.length);
    const jpegPrefix = header.subarray(0, JPEG_SIGNATURE.length);
    const gifPrefix = header.subarray(0, 6)
        .toString('latin1');
    const riffPrefix = header.subarray(0, 4)
        .toString('latin1');
    const webpMarker = header.subarray(8, 12)
        .toString('latin1');

    if (pngPrefix.equals(PNG_SIGNATURE)) {
        return 'image/png';
    }

    if (jpegPrefix.equals(JPEG_SIGNATURE)) {
        return 'image/jpeg';
    }

    if (gifPrefix === 'GIF87a' || gifPrefix === 'GIF89a') {
        return 'image/gif';
    }

    if (riffPrefix === 'RIFF' && webpMarker === 'WEBP') {
        return 'image/webp';
    }

    return undefined;
}

function planUpload(file: File, uploadDir: string): UploadPlan {
    const id = randomUUID();

    return { file, id, absolutePath: join(uploadDir, `${id}${cleanExtension(file.name)}`) };
}

// The flag 'wx' fails on an existing name, so a file is never overwritten.
// The mode is set on the open handle, because the umask would strip it at creation.
async function writeUpload(plan: UploadPlan): Promise<SavedUpload> {
    const arrayBuffer = await plan.file.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const handle = await open(plan.absolutePath, 'wx', UPLOAD_FILE_MODE);

    try {
        await handle.writeFile(bytes);
        await handle.chmod(UPLOAD_FILE_MODE);
    } finally {
        await handle.close();
    }

    return {
        id: plan.id,
        name: cleanDisplayName(plan.file.name),
        absolutePath: plan.absolutePath,
        mimeType: detectImageMimeType(bytes) ?? DEFAULT_MIME_TYPE,
        sizeBytes: bytes.length,
        bytes,
    };
}

async function removePaths(paths: string[]): Promise<void> {
    const removals = paths.map(path => rm(path, { force: true }));

    await Promise.all(removals);
}

async function removeFiles(uploads: SavedUpload[]): Promise<void> {
    const paths = uploads.map(upload => upload.absolutePath);

    await removePaths(paths);
}

// Writes every file of one request into the bot's upload folder. If any write fails,
// every attempted path is removed, because a write can fail midway and leave a partial file.
async function saveFiles(uploadDir: string, files: File[]): Promise<SavedUpload[]> {
    await mkdir(uploadDir, { recursive: true, mode: UPLOAD_FOLDER_MODE });
    // mkdir applies the umask, so the folder mode is set again explicitly.
    await chmod(uploadDir, UPLOAD_FOLDER_MODE);

    const plans = files.map(file => planUpload(file, uploadDir));
    const attemptedPaths = plans.map(plan => plan.absolutePath);
    const writes = plans.map(plan => writeUpload(plan));
    const results = await Promise.allSettled(writes);
    const savedFiles = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
    const rejections = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    if (rejections.length > 0) {
        const firstRejection: unknown = rejections[0]?.reason;

        await removePaths(attemptedPaths);

        throw firstRejection;
    }

    return savedFiles;
}

// CLOUDBOT_MAX_UPLOAD_MB sets the upload size limit. Missing or invalid values use the default.
function readMaxUploadBytes(environment: NodeJS.ProcessEnv): number {
    const parsedMegabytes = Number.parseInt(environment.CLOUDBOT_MAX_UPLOAD_MB ?? '', 10);
    const megabytes = Number.isNaN(parsedMegabytes) || parsedMegabytes <= 0
        ? DEFAULT_MAX_UPLOAD_MB
        : parsedMegabytes;

    return megabytes * BYTES_PER_MEGABYTE;
}

export { MAX_FILES_PER_UPLOAD, detectImageMimeType, readMaxUploadBytes, removeFiles, saveFiles };
export type { SavedUpload };
