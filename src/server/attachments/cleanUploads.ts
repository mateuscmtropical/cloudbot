import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface CleanUploadsOptions {
    uploadRoot: string;
    // Files that a queued message still needs. They are never removed.
    protectedPaths: ReadonlySet<string>;
    maxAgeMs: number;
    nowMs: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A file that was uploaded and never sent is removed after this time.
const UNSENT_UPLOAD_MAX_AGE_MS = MS_PER_DAY;
const CLEANUP_INTERVAL_MS = MS_PER_DAY;

// CLOUDBOT_UPLOAD_RETENTION_DAYS sets how long used files stay. Missing or invalid values use the default.
function readUploadRetentionMs(environment: NodeJS.ProcessEnv): number {
    const parsedDays = Number.parseInt(environment.CLOUDBOT_UPLOAD_RETENTION_DAYS ?? '', 10);
    const days = Number.isNaN(parsedDays) || parsedDays <= 0 ? DEFAULT_RETENTION_DAYS : parsedDays;

    return days * MS_PER_DAY;
}

async function listNames(folder: string): Promise<string[]> {
    try {
        return await readdir(folder);
    } catch {
        // A missing folder means nothing was uploaded yet.
        return [];
    }
}

async function removeIfOld(path: string, options: CleanUploadsOptions): Promise<string | undefined> {
    try {
        const fileStats = await stat(path);

        if (!fileStats.isFile() || options.nowMs - fileStats.mtimeMs <= options.maxAgeMs) {
            return undefined;
        }

        await rm(path, { force: true });

        return path;
    } catch {
        // The file may vanish between the listing and the check. The next run tries again.
        return undefined;
    }
}

// Removes files older than maxAgeMs from every bot folder under uploadRoot. Returns the removed paths.
// The age comes from the modification time, which is the upload time because files are never rewritten.
async function removeOldUploads(options: CleanUploadsOptions): Promise<string[]> {
    const botFolders = await listNames(options.uploadRoot);
    const listBotFolder = async (botFolder: string): Promise<string[]> => {
        const folderPath = join(options.uploadRoot, botFolder);
        const names = await listNames(folderPath);

        return names.map(name => join(folderPath, name));
    };
    const folderListings = botFolders.map(listBotFolder);
    const candidateLists = await Promise.all(folderListings);
    const candidates = candidateLists.flat()
        .filter(path => !options.protectedPaths.has(path));
    const removalChecks = candidates.map(path => removeIfOld(path, options));
    const removals = await Promise.all(removalChecks);

    return removals.filter((path): path is string => path !== undefined);
}

export { CLEANUP_INTERVAL_MS, UNSENT_UPLOAD_MAX_AGE_MS, readUploadRetentionMs, removeOldUploads };
export type { CleanUploadsOptions };
