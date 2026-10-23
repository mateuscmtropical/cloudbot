import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLoginSessionTables, SESSION_LIFETIME_MS, SqliteLoginSessions } from './LoginSessions.ts';

describe('SqliteLoginSessions', () => {
    let database: DatabaseSync;
    let sessions: SqliteLoginSessions;

    beforeEach(() => {
        database = new DatabaseSync(':memory:');
        createLoginSessionTables(database);
        sessions = new SqliteLoginSessions(database);
    });

    afterEach(() => {
        database.close();
    });

    it('stores only a hash and expires a random 256 bit token after thirty days', () => {
        const token = sessions.create('maria', 1000);
        const rows = database.prepare('SELECT token_hash, expires_at FROM login_sessions')
            .all();
        const tokenHash = rows[0]?.token_hash;
        const expiresAt = rows[0]?.expires_at;

        expect(token)
            .not.toHaveLength(0);
        expect(tokenHash)
            .not.toBe(token);
        expect(expiresAt)
            .toBe(1000 + SESSION_LIFETIME_MS);
        expect(sessions.find(token, 1000))
            .toBe('maria');
        expect(sessions.find(token, 1001 + SESSION_LIFETIME_MS))
            .toBeUndefined();
    });

    it('ends a selected session, all sessions, or all other sessions for a person', () => {
        const first = sessions.create('maria', 0);
        const second = sessions.create('maria', 0);
        const third = sessions.create('joao', 0);

        sessions.deleteOtherSessions('maria', first);

        expect(sessions.find(first, 1))
            .toBe('maria');
        expect(sessions.find(second, 1))
            .toBeUndefined();
        expect(sessions.find(third, 1))
            .toBe('joao');

        sessions.delete(first);
        sessions.deletePerson('joao');

        expect(sessions.find(first, 1))
            .toBeUndefined();
        expect(sessions.find(third, 1))
            .toBeUndefined();
    });
});

export {};
