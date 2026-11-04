import { chmodSync } from 'node:fs';

const PRIVATE_FILE_MODE = 0o600;
const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm'];

function readErrorCode(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

// The data folder is already closed to other users, so this is a second layer. A failure only logs and never stops the
// start. SQLite gives a later -wal or -shm file the mode of the main file.
function restrictDatabaseFiles(databasePath: string): void {
    DATABASE_FILE_SUFFIXES.forEach((suffix) => {
        try {
            chmodSync(`${databasePath}${suffix}`, PRIVATE_FILE_MODE);
        } catch (error: unknown) {
            if (readErrorCode(error) !== 'ENOENT') {
                console.error(`Could not make ${databasePath}${suffix} private.`);
            }
        }
    });
}

export { restrictDatabaseFiles };
