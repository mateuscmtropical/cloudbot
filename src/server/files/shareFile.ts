import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, realpath, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface SharedFileCopy {
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
}

interface ShareWorkspaceFileOptions {
    workspaceDir: string;
    requestedPath: string;
    // The folder that receives the copy. It must exist.
    shareDir: string;
    maxBytes: number;
    fileId: string;
}

// The message is written for the model, so it can fix the call and try again.
class ShareFileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ShareFileError';
    }
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const DEFAULT_MAX_SHARE_MB = 50;
const COPY_FILE_MODE = 0o600;
const MAX_NAME_LENGTH = 120;
const DEFAULT_MIME_TYPE = 'application/octet-stream';
// Unknown types, and types a browser would run such as html or svg, stay octet-stream.
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.zip': 'application/zip',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
// O_NONBLOCK keeps the open of a named pipe from waiting for a writer. The regular file check follows.
// Windows has neither flag, so the open follows links there. The realpath and identity checks guard on every OS.
const OPEN_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function readMaxShareBytes(): number {
    return DEFAULT_MAX_SHARE_MB * BYTES_PER_MEGABYTE;
}

function guessMimeType(fileName: string): string {
    return MIME_TYPES_BY_EXTENSION[extname(fileName)
        .toLowerCase()] ?? DEFAULT_MIME_TYPE;
}

function cleanShareName(requestedName: string): string {
    const printableName = requestedName
        .replaceAll(/\p{Cc}/gu, '')
        .trim();

    if (printableName === '' || printableName === '.' || printableName === '..') {
        return 'file';
    }

    return Array.from(printableName)
        .slice(0, MAX_NAME_LENGTH)
        .join('');
}

function isInside(rootDir: string, targetPath: string): boolean {
    const relativePath = relative(rootDir, targetPath);

    const leavesRoot = relativePath === '..' || relativePath.startsWith(`..${sep}`);

    return relativePath !== '' && !leavesRoot && !isAbsolute(relativePath);
}

// Windows file ids are 64 bits, so the comparison uses bigints. A Number would lose the low digits.
// Some network and virtual filesystems report an inode of 0 for every file, so 0 never counts as a match.
function isSameFile(first: BigIntStats, second: BigIntStats): boolean {
    return first.ino !== 0n && first.dev === second.dev && first.ino === second.ino;
}

async function resolveRealPath(path: string, failureText: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        throw new ShareFileError(failureText);
    }
}

async function statPath(path: string, failureText: string): Promise<BigIntStats> {
    try {
        return await stat(path, { bigint: true });
    } catch {
        throw new ShareFileError(failureText);
    }
}

// A transform that fails when more than maxBytes pass, so a file that grows during the copy cannot fill the disk.
function limitBytes(maxBytes: number): Transform {
    let seenBytes = 0;

    return new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
            seenBytes += chunk.length;

            if (seenBytes > maxBytes) {
                callback(new ShareFileError('The file grew past the size limit while it was copied.'));

                return;
            }

            callback(null, chunk);
        },
    });
}

// Copies one regular file of the workspace into the share folder. The real path must stay
// inside the workspace, so a link out of it is refused. The bot cannot change the copy afterwards.
async function shareWorkspaceFile(options: ShareWorkspaceFileOptions): Promise<SharedFileCopy> {
    const workspaceReal = await resolveRealPath(options.workspaceDir, 'The workspace is not available.');
    const requestedAbsolute = resolve(options.workspaceDir, options.requestedPath);
    const requestedReal = await resolveRealPath(
        requestedAbsolute,
        'No file exists at that path. Use a path inside your workspace.',
    );

    if (!isInside(workspaceReal, requestedReal)) {
        throw new ShareFileError('Only files inside your workspace can be shared.');
    }

    // The path check above can be outdated when the bot swaps a folder for a link, so the open file is checked again.
    let sourceHandle;

    try {
        sourceHandle = await open(requestedReal, OPEN_FILE_FLAGS);
    } catch {
        throw new ShareFileError('That file cannot be opened.');
    }

    const destinationPath = join(options.shareDir, options.fileId);

    try {
        const sourceStat = await sourceHandle.stat({ bigint: true });
        const pathReal = await resolveRealPath(requestedAbsolute, 'That file cannot be opened.');

        if (!isInside(workspaceReal, pathReal)) {
            throw new ShareFileError('Only files inside your workspace can be shared.');
        }

        // The path must still lead to the file that was opened. This works on every OS, unlike /proc/self/fd.
        const pathStat = await statPath(pathReal, 'That file cannot be opened.');

        if (!isSameFile(sourceStat, pathStat)) {
            throw new ShareFileError('That file changed while it was being shared. Try again.');
        }

        if (!sourceStat.isFile()) {
            throw new ShareFileError('Only regular files can be shared, not folders.');
        }

        if (sourceStat.size > BigInt(options.maxBytes)) {
            const limitMb = Math.floor(options.maxBytes / BYTES_PER_MEGABYTE);

            throw new ShareFileError(`The file is larger than ${String(limitMb)} MB.`);
        }

        const destinationHandle = await open(destinationPath, CREATE_FLAGS, COPY_FILE_MODE);

        const sourceStream = sourceHandle.createReadStream({ autoClose: false });
        const sizeLimit = limitBytes(options.maxBytes);
        const destinationStream = destinationHandle.createWriteStream();

        await pipeline(sourceStream, sizeLimit, destinationStream);

        const realName = basename(requestedReal);
        const name = cleanShareName(realName);
        const copyStat = await stat(destinationPath);

        return { id: options.fileId, name, mimeType: guessMimeType(name), sizeBytes: copyStat.size };
    } catch (error: unknown) {
        await rm(destinationPath, { force: true });

        throw error;
    } finally {
        await sourceHandle.close();
    }
}

export { DEFAULT_MAX_SHARE_MB, ShareFileError, cleanShareName, guessMimeType, isSameFile, readMaxShareBytes, shareWorkspaceFile };
export type { SharedFileCopy, ShareWorkspaceFileOptions };
