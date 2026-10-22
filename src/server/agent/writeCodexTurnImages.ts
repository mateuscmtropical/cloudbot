import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TurnImage, TurnImageMediaType } from './AgentRunner.ts';

interface CodexTurnImages {
    paths: string[];
    remove(): void;
}

const EXTENSIONS: Record<TurnImageMediaType, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
// With an agent user, Codex runs as that user and reads the images through the group of the turn root.
const GROUP_FOLDER_MODE = 0o750;
const GROUP_FILE_MODE = 0o640;

// Codex takes an image as a file path (a localImage input) and reads the file itself. Each turn writes its images to a
// new private folder in the bot's CODEX_HOME, which CloudBot owns, and removes it when the turn ends.
function writeCodexTurnImages(codexHome: string, images: TurnImage[], isGroupReadable = false): CodexTurnImages {
    if (images.length === 0) {
        return { paths: [], remove: () => undefined };
    }

    const folderPrefix = join(codexHome, 'turn-images-');
    const folder = mkdtempSync(folderPrefix);

    const remove = (): void => {
        rmSync(folder, { recursive: true, force: true });
    };
    let paths: string[];

    // A write that fails part way, such as on a full disk, removes what was written before the error goes up.
    try {
        chmodSync(folder, isGroupReadable ? GROUP_FOLDER_MODE : PRIVATE_FOLDER_MODE);
        paths = images.map((image, index) => {
            const path = join(folder, `image-${String(index + 1)}.${EXTENSIONS[image.mediaType]}`);
            const bytes = Buffer.from(image.data, 'base64');

            writeFileSync(path, bytes, { mode: isGroupReadable ? GROUP_FILE_MODE : PRIVATE_FILE_MODE });

            return path;
        });
    } catch (error: unknown) {
        remove();

        throw error;
    }

    return { paths, remove };
}

export { writeCodexTurnImages };
export type { CodexTurnImages };
