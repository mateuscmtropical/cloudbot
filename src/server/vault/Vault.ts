import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_FILE_NAME = 'vault.key';
const DATA_FILE_NAME = 'vault.json';
const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const CIPHER_ALGORITHM = 'aes-256-gcm';
const OWNER_ONLY_MODE = 0o600;
const FOLDER_MODE = 0o700;
const JSON_INDENT_SPACES = 4;

interface EncryptedSecret {
    iv: string;
    tag: string;
    ciphertext: string;
}

interface VaultFile {
    version: 1;
    secrets: Record<string, EncryptedSecret>;
}

function writeFileAtomic(filePath: string, content: string): void {
    const temporaryPath = `${filePath}.tmp`;

    // A temp file renamed over the target means a crash never leaves a half written vault.
    writeFileSync(temporaryPath, content, { mode: OWNER_ONLY_MODE });
    renameSync(temporaryPath, filePath);
}

function loadOrCreateKey(keyPath: string): Buffer {
    if (existsSync(keyPath)) {
        const storedKey = readFileSync(keyPath);

        if (storedKey.length !== KEY_BYTE_LENGTH) {
            throw new Error(`${KEY_FILE_NAME} must be ${String(KEY_BYTE_LENGTH)} bytes.`);
        }

        return storedKey;
    }

    const newKey = randomBytes(KEY_BYTE_LENGTH);

    // The 'wx' flag refuses to overwrite a key that appeared in the meantime.
    writeFileSync(keyPath, newKey, { flag: 'wx', mode: OWNER_ONLY_MODE });

    return newKey;
}

function encryptValue(key: Buffer, value: string): EncryptedSecret {
    const iv = randomBytes(IV_BYTE_LENGTH);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
    const updatedChunk = cipher.update(value, 'utf8');
    const finalChunk = cipher.final();
    const ciphertext = Buffer.concat([updatedChunk, finalChunk]);
    const authTag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        tag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
}

function decryptValue(key: Buffer, encryptedSecret: EncryptedSecret): string {
    const iv = Buffer.from(encryptedSecret.iv, 'base64');
    const authTag = Buffer.from(encryptedSecret.tag, 'base64');
    const ciphertext = Buffer.from(encryptedSecret.ciphertext, 'base64');
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);

    decipher.setAuthTag(authTag);

    const updatedChunk = decipher.update(ciphertext);
    const finalChunk = decipher.final();
    const plainText = Buffer.concat([updatedChunk, finalChunk]);

    return plainText.toString('utf8');
}

class Vault {
    private readonly key: Buffer;
    private readonly dataPath: string;

    constructor(folderPath: string) {
        mkdirSync(folderPath, { recursive: true, mode: FOLDER_MODE });

        const keyPath = join(folderPath, KEY_FILE_NAME);

        this.dataPath = join(folderPath, DATA_FILE_NAME);
        this.key = loadOrCreateKey(keyPath);

        if (!existsSync(this.dataPath)) {
            this.writeFile({ version: 1, secrets: {} });
        }
    }

    set(name: string, value: string): void {
        if (name.length === 0) {
            throw new Error('Secret name cannot be empty.');
        }

        if (value.length === 0) {
            throw new Error('Secret value cannot be empty.');
        }

        const vaultFile = this.readFile();
        const encryptedSecret = encryptValue(this.key, value);

        vaultFile.secrets[name] = encryptedSecret;
        this.writeFile(vaultFile);
    }

    get(name: string): string | undefined {
        const vaultFile = this.readFile();
        const encryptedSecret: EncryptedSecret | undefined = vaultFile.secrets[name];

        if (encryptedSecret === undefined) {
            return undefined;
        }

        return decryptValue(this.key, encryptedSecret);
    }

    has(name: string): boolean {
        const vaultFile = this.readFile();

        return Object.hasOwn(vaultFile.secrets, name);
    }

    delete(name: string): void {
        const vaultFile = this.readFile();

        Reflect.deleteProperty(vaultFile.secrets, name);
        this.writeFile(vaultFile);
    }

    listNames(): string[] {
        const vaultFile = this.readFile();

        return Object.keys(vaultFile.secrets);
    }

    private readFile(): VaultFile {
        const content = readFileSync(this.dataPath, 'utf8');
        const parsedFile: unknown = JSON.parse(content);

        return parsedFile as VaultFile;
    }

    private writeFile(vaultFile: VaultFile): void {
        const content = JSON.stringify(vaultFile, null, JSON_INDENT_SPACES);

        writeFileAtomic(this.dataPath, content);
    }
}

export { Vault };
