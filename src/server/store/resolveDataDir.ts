import { join } from 'node:path';

const DEFAULT_DATA_DIR = './data';
const DATABASE_FILE_NAME = 'cloudbot.db';

function resolveDataDir(): string {
    const configuredDir = process.env.CLOUDBOT_DATA_DIR ?? '';

    return configuredDir === '' ? DEFAULT_DATA_DIR : configuredDir;
}

function databasePath(dataDir: string): string {
    return join(dataDir, DATABASE_FILE_NAME);
}

export { databasePath, resolveDataDir };
