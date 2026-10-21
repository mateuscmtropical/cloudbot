import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

// The message is written for the model, so it can fix the call and try again.
class IntegrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IntegrationError';
    }
}

const MAX_ENTRY_BYTES = 256 * 1024;
const PARENT_SEGMENT = '..';
// A link is refused at the open, and a FIFO or device is refused without waiting for a writer.
const ENTRY_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Reads the entry file of an integration. The path must stay inside the workspace, also after links are followed.
async function readEntryFile(workspaceDir: string, entryPath: string): Promise<Buffer> {
    const segments = entryPath.split(/[/]/);

    if (entryPath.trim() === '' || isAbsolute(entryPath) || segments.includes(PARENT_SEGMENT)) {
        throw new IntegrationError('The entry file must be a path inside the bot workspace, without ".." and without a leading slash.');
    }

    const workspaceReal = await realpath(workspaceDir);
    let fileReal: string;

    try {
        const entryLocation = join(workspaceDir, entryPath);

        fileReal = await realpath(entryLocation);
    } catch {
        throw new IntegrationError('The entry file was not found in the bot workspace.');
    }

    const inside = relative(workspaceReal, fileReal);

    if (inside === '' || isAbsolute(inside) || inside.split(sep)[0] === PARENT_SEGMENT) {
        throw new IntegrationError('The entry file must be inside the bot workspace.');
    }

    return readRegularFile(fileReal);
}

// Reads from the open handle, so the file checked is the file read. The read stops one byte past the limit.
async function readRegularFile(filePath: string): Promise<Buffer> {
    let handle: FileHandle;

    try {
        handle = await open(filePath, ENTRY_OPEN_FLAGS);
    } catch {
        throw new IntegrationError('The entry file could not be read.');
    }

    try {
        const info = await handle.stat();

        if (!info.isFile()) {
            throw new IntegrationError('The entry file must be a regular file.');
        }

        const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);

        if (bytesRead > MAX_ENTRY_BYTES) {
            throw new IntegrationError('The entry file is larger than 256 KB.');
        }

        return buffer.subarray(0, bytesRead);
    } catch (error: unknown) {
        if (error instanceof IntegrationError) {
            throw error;
        }

        throw new IntegrationError('The entry file could not be read.');
    } finally {
        await handle.close();
    }
}

function hashContent(content: Buffer): string {
    return createHash('sha256')
        .update(content)
        .digest('hex');
}

export { IntegrationError, MAX_ENTRY_BYTES, hashContent, readEntryFile };
