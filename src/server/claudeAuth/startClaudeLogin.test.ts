import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startClaudeLogin } from './startClaudeLogin.ts';
import type { ClaudeLoginSession, SpawnLoginProcess } from './startClaudeLogin.ts';

const FIXTURE_PATH = fileURLToPath(new URL('../../../test/fixtures/claude-login.js', import.meta.url));
const SESSIONS: ClaudeLoginSession[] = [];
const SPAWN_FAKE: SpawnLoginProcess = () => spawn(process.execPath, [FIXTURE_PATH]);

function startFakeLogin(timeoutMs = 5000): ClaudeLoginSession {
    const session = startClaudeLogin({ claudePath: 'claude', spawnProcess: SPAWN_FAKE, timeoutMs });

    SESSIONS.push(session);

    return session;
}

afterEach(async () => {
    SESSIONS.forEach((session) => {
        session.cancel();
    });
    await Promise.all(SESSIONS.map(session => session.finished));
    SESSIONS.length = 0;
});

describe('startClaudeLogin', () => {
    it('parses the sign-in URL after removing ANSI output and accepts a good code', async () => {
        const session = startFakeLogin();

        expect(await session.signInUrl)
            .toBe('https://example.com/authorize?state=fake');
        session.submitCode('good-code');
        expect(await session.finished)
            .toEqual({ ok: true });
        session.cancel();
        expect(await session.finished)
            .toEqual({ ok: true });
    });

    it('reports a wrong code as exitedWithError', async () => {
        const session = startFakeLogin();

        await session.signInUrl;
        session.submitCode('bad-code');
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'exitedWithError' });
    });

    it('times out and settles the URL promise when no link arrives', async () => {
        const session = startClaudeLogin({
            claudePath: 'claude',
            spawnProcess: () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']),
            timeoutMs: 30,
        });

        SESSIONS.push(session);
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'timeout' });
        expect(await session.signInUrl)
            .toBeNull();
    });

    it('reports a missing executable from a spawn ENOENT error', async () => {
        const session = startClaudeLogin({
            claudePath: 'claude',
            spawnProcess: () => spawn('cloudbot-missing-claude-executable', []),
        });

        SESSIONS.push(session);
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'cliMissing' });
        expect(await session.signInUrl)
            .toBeNull();
    });

    it('cancels a pending login and ignores later submissions', async () => {
        const session = startFakeLogin();

        await session.signInUrl;
        session.cancel();
        session.submitCode('good-code');
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'cancelled' });
    });

    it('quotes the CLI path as one shell argument for util-linux script', async () => {
        const spawnProcess = vi.fn(SPAWN_FAKE);
        const session = startClaudeLogin({ claudePath: '/opt/Claude\'s tools/$(unsafe)/claude', spawnProcess });

        SESSIONS.push(session);
        expect(spawnProcess)
            .toHaveBeenCalledWith('script', [
                '-q', '-e', '-c', '\'/opt/Claude\'"\'"\'s tools/$(unsafe)/claude\' auth login --claudeai', '/dev/null',
            ]);
        await session.signInUrl;
        session.cancel();
    });

    it('waits for the full first URL across output chunks', async () => {
        const session = startClaudeLogin({
            claudePath: 'claude',
            spawnProcess: () => spawn(process.execPath, ['-e',
                'process.stdout.write(\'\u001b[32mhttps://example.com/\'); setTimeout(() => { process.stdout.write(\'login\u001b[0m https://other.example/\\n\'); }, 30)',
            ]),
        });

        SESSIONS.push(session);
        expect(await session.signInUrl)
            .toBe('https://example.com/login');
        expect(await session.finished)
            .toEqual({ ok: true });
    });

    it('rejects multiple lines in a code without writing them to the CLI', async () => {
        const session = startFakeLogin();

        await session.signInUrl;
        expect(() => {
            session.submitCode('good-code\nother-command');
        })
            .toThrow('single line');
        session.submitCode('good-code');
        expect(await session.finished)
            .toEqual({ ok: true });
    });

    it('maps the shell command-not-found exit code to cliMissing', async () => {
        const session = startClaudeLogin({
            claudePath: 'claude',
            spawnProcess: () => spawn(process.execPath, ['-e', 'process.exitCode = 127']),
        });

        SESSIONS.push(session);
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'cliMissing' });
    });
});
