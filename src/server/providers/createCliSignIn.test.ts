import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createCliSignIn, findLink } from './createCliSignIn.ts';

class FakeLogin extends EventEmitter {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    pid = 5151;
}

function makeSignIn(isSignedIn: () => Promise<boolean | undefined>): { signIn: ReturnType<typeof createCliSignIn>; logins: FakeLogin[]; signals: string[] } {
    const logins: FakeLogin[] = [];
    const signals: string[] = [];
    const signIn = createCliSignIn({
        id: 'copilot',
        label: 'Copilot',
        site: 'GitHub',
        command: '/usr/bin/sudo',
        args: ['login'],
        environment: {},
        isSignedIn,
        spawnFunction: () => {
            const login = new FakeLogin();

            logins.push(login);

            return login as unknown as ChildProcess;
        },
        signalProcess: (_child, action) => {
            signals.push(action);
        },
    });

    return { signIn, logins, signals };
}

describe('createCliSignIn', () => {
    it('finds the link and the device code in the CLI output', () => {
        expect(findLink('To authenticate, visit https://github.com/login/device and enter code B8CF-3B47\n'))
            .toEqual({ url: 'https://github.com/login/device', code: 'B8CF-3B47' });
        expect(findLink('\u001B[90m  https://accounts.x.ai/oauth2/device?user_code=HKDG-V7WR\u001B[0m\n'))
            .toEqual({ url: 'https://accounts.x.ai/oauth2/device?user_code=HKDG-V7WR', code: 'HKDG-V7WR' });
        expect(findLink('Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=d30\n'))
            .toEqual({ url: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=d30' });
        expect(findLink('Starting login process...'))
            .toBeUndefined();
    });

    it('shows the link, then reports a sign-in the CLI finished', async () => {
        const isSignedIn = vi.fn(() => Promise.resolve(true));
        const { signIn, logins } = makeSignIn(isSignedIn);

        const session = signIn.start();

        logins[0]?.stdout.write('To authenticate, visit https://github.com/login/device and enter code B8CF-3B47\n');

        expect(await session.link)
            .toEqual({ url: 'https://github.com/login/device', code: 'B8CF-3B47' });
        logins[0]?.emit('exit', 0);
        expect(await session.finished)
            .toEqual({ ok: true });
        expect(isSignedIn)
            .toHaveBeenCalledOnce();
    });

    it('fails when the CLI ends with an error or the sign-in does not work', async () => {
        const failed = makeSignIn(() => Promise.resolve(true));
        const unfinished = makeSignIn(() => Promise.resolve(false));

        const first = failed.signIn.start();
        const second = unfinished.signIn.start();

        failed.logins[0]?.emit('exit', 1);
        unfinished.logins[0]?.emit('exit', 0);

        expect(await first.finished)
            .toEqual({ ok: false, reason: 'Copilot sign-in failed.' });
        expect(await first.link)
            .toBeNull();
        expect(await second.finished)
            .toEqual({ ok: false, reason: 'Copilot sign-in failed.' });
    });

    it('marks a link that needs a pasted code and passes the code to the CLI', async () => {
        const logins: FakeLogin[] = [];
        const signIn = createCliSignIn({
            id: 'gemini', label: 'Gemini', site: 'Google', command: '/usr/bin/sudo', args: ['login'], environment: {}, needsCode: true,
            isSignedIn: () => Promise.resolve(true),
            spawnFunction: () => {
                const login = new FakeLogin();

                logins.push(login);

                return login as unknown as ChildProcess;
            },
            signalProcess: () => undefined,
        });
        const session = signIn.start();
        const written: string[] = [];

        logins[0]?.stdin.on('data', (chunk: Buffer) => {
            written.push(chunk.toString('utf8'));
        });
        logins[0]?.stderr.write('Please visit the following URL to authorize the application:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=681255809395-oo8f\n');

        expect(await session.link)
            .toEqual({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=681255809395-oo8f', needsCode: true });
        session.submitCode?.('4/0Ab');
        await vi.waitFor(() => {
            expect(written)
                .toEqual(['4/0Ab\n']);
        });
    });

    it('stops and says so when the CLI refuses the pasted code', async () => {
        const { signIn, logins, signals } = makeSignIn(() => Promise.resolve(false));

        const session = signIn.start();

        logins[0]?.stderr.write('Failed to authenticate with user code. Retrying...\nhttps://github.com/login/device B8CF-3B47\n');
        session.submitCode?.('4/0Ab');
        logins[0]?.stderr.write('Failed to authenticate with authorization code:invalid_grant\n');
        logins[0]?.emit('exit', null);

        expect(signals)
            .toEqual(['KILL']);
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'Copilot did not accept the code. Try again with a new code.' });
    });

    it('kills the CLI when the owner cancels', async () => {
        const { signIn, logins, signals } = makeSignIn(() => Promise.resolve(true));

        const session = signIn.start();

        session.cancel();
        logins[0]?.emit('exit', null);

        expect(signals)
            .toEqual(['KILL']);
        expect(await session.finished)
            .toEqual({ ok: false, reason: 'Copilot sign-in timed out or was cancelled.' });
    });
});
