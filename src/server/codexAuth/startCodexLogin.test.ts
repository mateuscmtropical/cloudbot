import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAccountSpawn, missingSpawn } from './FakeCodexAccountServer.ts';
import type { FakeAccountAnswers } from './FakeCodexAccountServer.ts';
import { startCodexLogin } from './startCodexLogin.ts';

const DEVICE_CODE = { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.example.test/device', userCode: 'ABCD-1234' };

function makeHome(): string {
    return join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-login-')), 'codex-home');
}

function startFake(answers: FakeAccountAnswers, timeoutMs = 5000): ReturnType<typeof fakeAccountSpawn> & { session: ReturnType<typeof startCodexLogin>; home: string } {
    const fake = fakeAccountSpawn(answers);
    const home = makeHome();
    const session = startCodexLogin({
        codexPath: '/usr/local/bin/codex',
        codexHome: home,
        environment: { PATH: '/usr/bin' },
        spawnFunction: fake.spawnFunction,
        signalProcess: () => undefined,
        timeoutMs,
    });

    return { ...fake, session, home };
}

const START_ONLY: FakeAccountAnswers = [
    ['account/login/start', () => ({ result: DEVICE_CODE })],
    ['account/login/cancel', () => ({ result: { status: 'canceled' } })],
];

describe('startCodexLogin', () => {
    it('starts a device code sign-in in the bot\'s own CODEX_HOME with a clean environment', async () => {
        const { session, spawnCalls, servers, home } = startFake(START_ONLY);

        await expect(session.deviceCode).resolves.toEqual({ verificationUrl: DEVICE_CODE.verificationUrl, userCode: DEVICE_CODE.userCode });
        expect(spawnCalls[0]?.args[0])
            .toBe('app-server');
        expect(spawnCalls[0]?.env)
            .toEqual({ PATH: '/usr/bin', HOME: home, CODEX_HOME: home });
        expect(statSync(home).mode & 0o777)
            .toBe(0o700);

        const start = servers[0]?.sent.find(message => message.method === 'account/login/start');

        expect(start?.params)
            .toEqual({ type: 'chatgptDeviceCode' });
        session.cancel();
        await session.finished;
    });

    it('finishes when Codex reports the sign-in done, and closes the app server', async () => {
        const { session, servers } = startFake(START_ONLY);

        await session.deviceCode;
        servers[0]?.say({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null, onboardingEntrypoint: null } });

        await expect(session.finished).resolves.toEqual({ ok: true });
        await expect.poll(() => servers[0]?.stdin.writableEnded)
            .toBe(true);
        expect(servers[0]?.methods())
            .not
            .toContain('account/login/cancel');
    });

    it('ignores the completion of another sign-in', async () => {
        const { session, servers } = startFake(START_ONLY);

        await session.deviceCode;
        servers[0]?.say({ method: 'account/login/completed', params: { loginId: 'login-9', success: true, error: null, onboardingEntrypoint: null } });
        servers[0]?.say({ method: 'account/login/completed', params: { loginId: 'login-1', success: false, error: 'denied', onboardingEntrypoint: null } });

        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'refused' });
    });

    it('cancels the sign-in in Codex when the owner cancels', async () => {
        const { session, servers } = startFake(START_ONLY);

        await session.deviceCode;
        session.cancel();

        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'cancelled' });
        await expect.poll(() => servers[0]?.stdin.writableEnded)
            .toBe(true);

        const cancel = servers[0]?.sent.find(message => message.method === 'account/login/cancel');

        expect(cancel?.params)
            .toEqual({ loginId: 'login-1' });
    });

    it('times out and cancels the sign-in in Codex', async () => {
        const { session, servers } = startFake(START_ONLY, 50);

        await session.deviceCode;

        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'timeout' });
        await expect.poll(() => servers[0]?.methods())
            .toContain('account/login/cancel');
    });

    it('fails when the app server exits before the sign-in is done', async () => {
        const { session, servers } = startFake(START_ONLY);

        await session.deviceCode;
        servers[0]?.exit();

        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'exitedWithError' });
    });

    it('refuses an answer that is not a device code', async () => {
        const { session } = startFake([['account/login/start', () => ({ result: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/' } })]]);

        await expect(session.deviceCode).resolves.toBeNull();
        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'exitedWithError' });
    });

    it('refuses a verification page that is not https', async () => {
        const { session } = startFake([['account/login/start', () => ({ result: { ...DEVICE_CODE, verificationUrl: 'javascript:alert(1)' } })]]);

        await expect(session.deviceCode).resolves.toBeNull();
        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'exitedWithError' });
    });

    it('fails when Codex answers the start with an error', async () => {
        const { session } = startFake([['account/login/start', () => ({ error: { code: -32600, message: 'login disabled' } })]]);

        await expect(session.deviceCode).resolves.toBeNull();
        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'exitedWithError' });
    });

    it('reports a missing binary', async () => {
        const session = startCodexLogin({ codexPath: '/missing/codex', codexHome: makeHome(), spawnFunction: missingSpawn(), signalProcess: () => undefined });

        await expect(session.deviceCode).resolves.toBeNull();
        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'cliMissing' });
    });

    it('closes the app server when cancelled before Codex gives a code', async () => {
        const { session, servers } = startFake([['account/login/start', () => undefined]]);

        await expect.poll(() => servers[0]?.methods())
            .toContain('account/login/start');
        session.cancel();

        await expect(session.deviceCode).resolves.toBeNull();
        await expect(session.finished).resolves.toEqual({ ok: false, reason: 'cancelled' });
        await expect.poll(() => servers[0]?.stdin.writableEnded)
            .toBe(true);
    });
});
