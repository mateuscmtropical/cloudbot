import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MIGRATIONS_FOLDER_NAME = 'drizzle';
const JOURNAL_RELATIVE_PATH = join('meta', '_journal.json');

// Searches upward from the given folder for drizzle/. The server runs from
// dist/server in the image and from src/server/store in development, so the
// lookup starts from the module, not from the working directory.
function findMigrationsFolder(startDirectory: string): string {
    const candidateFolder = join(startDirectory, MIGRATIONS_FOLDER_NAME);
    const journalPath = join(candidateFolder, JOURNAL_RELATIVE_PATH);

    if (existsSync(journalPath)) {
        return candidateFolder;
    }

    const parentDirectory = dirname(startDirectory);

    if (parentDirectory === startDirectory) {
        throw new Error('Could not find the drizzle migrations folder.');
    }

    return findMigrationsFolder(parentDirectory);
}

export { findMigrationsFolder };
