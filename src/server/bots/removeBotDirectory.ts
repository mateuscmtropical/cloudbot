import type { Stats } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

const BOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// Removes root/botId with everything in it. A link at that path is removed itself and never followed.
// A folder that resolves outside root is refused. A missing folder is not an error.
async function removeBotDirectory(root: string, botId: string): Promise<void> {
    if (!BOT_ID_PATTERN.test(botId)) {
        throw new Error('Invalid bot id for a folder.');
    }

    const target = join(root, botId);
    let entry: Stats;

    try {
        entry = await lstat(target);
    } catch (error: unknown) {
        if (isNotFound(error)) {
            return;
        }

        throw error;
    }

    if (!entry.isSymbolicLink()) {
        const realRoot = await realpath(root);
        const realTarget = await realpath(target);

        if (!realTarget.startsWith(`${realRoot}${sep}`)) {
            throw new Error('The bot folder is outside its root, so it was not removed.');
        }
    }

    await rm(target, { recursive: true, force: true });
}

export { removeBotDirectory };
