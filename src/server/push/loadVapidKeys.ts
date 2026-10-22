import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { JsonWebKey } from 'node:crypto';
import { join } from 'node:path';

import { generateVapidKeyPair, readVapidPublicKey } from './webPushCrypto.ts';
import type { VapidKeyPair } from './webPushCrypto.ts';

const KEY_FILE_NAME = 'push-vapid.json';
const OWNER_ONLY_MODE = 0o600;
const FOLDER_MODE = 0o700;
const JSON_INDENT_SPACES = 4;

interface VapidKeyFile {
    version: 1;
    privateJwk: JsonWebKey;
}

function readKeyFile(keyPath: string): VapidKeyPair {
    const fileText = readFileSync(keyPath, 'utf8');
    const parsed = JSON.parse(fileText) as Partial<VapidKeyFile>;
    const privateJwk = parsed.privateJwk;
    const publicKey = privateJwk === undefined ? undefined : readVapidPublicKey(privateJwk);

    if (privateJwk === undefined || publicKey === undefined) {
        throw new Error(`${KEY_FILE_NAME} does not hold a P-256 key.`);
    }

    // The mode of the file may have been loosened by a restore or a copy, so it is tightened on every start.
    chmodSync(keyPath, OWNER_ONLY_MODE);

    return { publicKey, privateJwk };
}

// The key pair that signs push requests. It is made once and kept in the data folder, readable by the server user only.
// It is never logged and never sent to the bot. Only the public half goes to the browser.
function loadOrCreateVapidKeys(dataDir: string): VapidKeyPair {
    mkdirSync(dataDir, { recursive: true, mode: FOLDER_MODE });

    const keyPath = join(dataDir, KEY_FILE_NAME);

    if (existsSync(keyPath)) {
        return readKeyFile(keyPath);
    }

    const keys = generateVapidKeyPair();
    const keyFile: VapidKeyFile = { version: 1, privateJwk: keys.privateJwk };
    const fileText = JSON.stringify(keyFile, undefined, JSON_INDENT_SPACES);

    // The 'wx' flag refuses to overwrite a key that appeared in the meantime.
    try {
        writeFileSync(keyPath, fileText, { flag: 'wx', mode: OWNER_ONLY_MODE });
    } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
            return readKeyFile(keyPath);
        }

        throw error;
    }

    return keys;
}

export { KEY_FILE_NAME, loadOrCreateVapidKeys };
