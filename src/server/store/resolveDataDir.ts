import { join } from 'node:path';

const DATABASE_FILE_NAME = 'cloudbot.db';

function databasePath(dataDir: string): string {
    return join(dataDir, DATABASE_FILE_NAME);
}

export { databasePath };
