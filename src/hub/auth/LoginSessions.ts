import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

interface LoginSessions {
    create: (name: string, now: number) => string;
    find: (token: string, now: number) => string | undefined;
    delete: (token: string) => void;
    deleteOtherSessions: (name: string, exceptToken: string) => void;
    deletePerson: (name: string) => void;
}

interface SessionRow extends Record<string, SQLOutputValue> {
    name: string;
    token_hash: string;
    expires_at: number;
}

const SESSION_TOKEN_BYTES = 32;
const SESSION_HASH_BYTES = 32;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const CREATE_LOGIN_SESSIONS_TABLE = `
    CREATE TABLE IF NOT EXISTS login_sessions (
        token_hash TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )
`;

function hashToken(token: string): Buffer {
    const hash = createHash('sha256');

    hash.update(token);

    return hash.digest();
}

function createLoginSessionTables(database: DatabaseSync): void {
    database.exec(CREATE_LOGIN_SESSIONS_TABLE);
    database.exec('CREATE INDEX IF NOT EXISTS login_sessions_name_idx ON login_sessions (name)');
}

class SqliteLoginSessions implements LoginSessions {
    private readonly database: DatabaseSync;

    constructor(database: DatabaseSync) {
        this.database = database;
    }

    create(name: string, now: number): string {
        const tokenBytes = randomBytes(SESSION_TOKEN_BYTES);
        const token = tokenBytes.toString('base64url');
        const tokenHash = hashToken(token);
        const tokenHashHex = tokenHash.toString('hex');
        const expiresAt = now + SESSION_LIFETIME_MS;
        const statement = this.database.prepare('INSERT INTO login_sessions (token_hash, name, expires_at) VALUES (?, ?, ?)');

        statement.run(tokenHashHex, name, expiresAt);

        return token;
    }

    find(token: string, now: number): string | undefined {
        const candidateHash = hashToken(token);
        const candidateHashHex = candidateHash.toString('hex');
        const statement = this.database.prepare('SELECT name, token_hash, expires_at FROM login_sessions WHERE token_hash = ? AND expires_at > ?');
        const row = statement.get(candidateHashHex, now) as SessionRow | undefined;

        if (row === undefined) {
            return undefined;
        }

        const storedHash = Buffer.from(row.token_hash, 'hex');
        const isMatch = storedHash.length === SESSION_HASH_BYTES && timingSafeEqual(candidateHash, storedHash);

        return isMatch ? row.name : undefined;
    }

    delete(token: string): void {
        const tokenHash = hashToken(token);
        const tokenHashHex = tokenHash.toString('hex');
        const statement = this.database.prepare('DELETE FROM login_sessions WHERE token_hash = ?');

        statement.run(tokenHashHex);
    }

    deleteOtherSessions(name: string, exceptToken: string): void {
        const exceptHash = hashToken(exceptToken);
        const exceptHashHex = exceptHash.toString('hex');
        const statement = this.database.prepare('DELETE FROM login_sessions WHERE name = ? AND token_hash <> ?');

        statement.run(name, exceptHashHex);
    }

    deletePerson(name: string): void {
        const statement = this.database.prepare('DELETE FROM login_sessions WHERE name = ?');

        statement.run(name);
    }
}

export { createLoginSessionTables, SESSION_LIFETIME_MS, SqliteLoginSessions };
export type { LoginSessions };
