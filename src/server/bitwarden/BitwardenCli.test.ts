import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BitwardenCli, BitwardenError, BitwardenRunError } from './BitwardenCli.ts';
import type { BitwardenAccount, BitwardenRunRequest } from './BitwardenCli.ts';

const ACCOUNT: BitwardenAccount = {
    serverUrl: 'https://vault.bitwarden.eu',
    clientId: 'user.11111111-2222-3333-4444-555555555555',
    clientSecret: 'fakeclientsecret0123456789',
    masterPassword: 'fake master password 1',
};
const SESSION_KEY = 'fake-session-key-0123456789abcdef';
const APP_DATA_DIR = '/data/bitwarden/abc';

interface FakeBw {
    calls: BitwardenRunRequest[];
    run: (request: BitwardenRunRequest) => Promise<string>;
}

interface FakeBwOptions {
    statusText?: string;
    failOn?: string;
    failWith?: BitwardenRunError;
    unlockOutput?: string;
    items?: unknown[];
}

function createFakeBw(options: FakeBwOptions = {}): FakeBw {
    const calls: BitwardenRunRequest[] = [];
    const statusText = options.statusText ?? JSON.stringify({ serverUrl: null, status: 'unauthenticated' });

    return {
        calls,
        run: (request) => {
            calls.push(request);

            const [command] = request.args;

            if (command === options.failOn) {
                return Promise.reject(options.failWith ?? new BitwardenRunError('failed', ''));
            }

            if (command === 'status') {
                return Promise.resolve(statusText);
            }

            if (command === 'unlock') {
                return Promise.resolve(options.unlockOutput ?? `${SESSION_KEY}\n`);
            }

            if (command === 'list') {
                return Promise.resolve(JSON.stringify(options.items ?? []));
            }

            if (command === 'get') {
                return Promise.resolve('fake-value\n');
            }

            return Promise.resolve('');
        },
    };
}

function createCli(fake: FakeBw, idleLockMs?: number): BitwardenCli {
    return new BitwardenCli({ account: ACCOUNT, appDataDir: APP_DATA_DIR, runner: fake.run, ...(idleLockMs === undefined ? {} : { idleLockMs }) });
}

function commandNames(fake: FakeBw): string[] {
    return fake.calls.map(call => call.args.join(' '));
}

describe('BitwardenCli', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sets the server, signs in with the API key, unlocks and syncs', async () => {
        const fake = createFakeBw();

        await createCli(fake)
            .unlock();

        expect(commandNames(fake))
            .toEqual([
                'status',
                'config server https://vault.bitwarden.eu',
                'login --apikey',
                'unlock --passwordenv BW_PASSWORD --raw',
                'sync',
            ]);
    });

    it('keeps every secret out of the arguments and in the environment', async () => {
        const fake = createFakeBw();

        await createCli(fake)
            .unlock();

        const allArguments = fake.calls.flatMap(call => call.args)
            .join(' ');
        const login = fake.calls.find(call => call.args[0] === 'login');
        const unlock = fake.calls.find(call => call.args[0] === 'unlock');
        const sync = fake.calls.find(call => call.args[0] === 'sync');

        expect(allArguments).not.toContain(ACCOUNT.masterPassword);
        expect(allArguments).not.toContain(ACCOUNT.clientSecret);
        expect(allArguments).not.toContain(ACCOUNT.clientId);
        expect(allArguments).not.toContain(SESSION_KEY);
        expect(login?.env)
            .toMatchObject({ BW_CLIENTID: ACCOUNT.clientId, BW_CLIENTSECRET: ACCOUNT.clientSecret });
        expect(unlock?.env)
            .toMatchObject({ BW_PASSWORD: ACCOUNT.masterPassword });
        expect(sync?.env)
            .toMatchObject({ BW_SESSION: SESSION_KEY });
    });

    it('gives bw its own folder and no unrelated variable of the server', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'fake-server-secret');
        vi.stubEnv('CLOUDBOT_DATA_DIR', '/var/lib/cloudbot');

        const fake = createFakeBw();

        await createCli(fake)
            .unlock();

        fake.calls.forEach((call) => {
            expect(call.env.BITWARDENCLI_APPDATA_DIR)
                .toBe(APP_DATA_DIR);
            expect(call.env.BW_NOINTERACTION)
                .toBe('true');
            expect(Object.keys(call.env)).not.toContain('ANTHROPIC_API_KEY');
            expect(Object.keys(call.env)).not.toContain('CLOUDBOT_DATA_DIR');
        });
        vi.unstubAllEnvs();
    });

    it('uses a timeout and an output limit on every command', async () => {
        const fake = createFakeBw();

        await createCli(fake)
            .unlock();

        fake.calls.forEach((call) => {
            expect(call.timeoutMs)
                .toBe(60_000);
            expect(call.maxOutputBytes)
                .toBeGreaterThan(0);
        });
    });

    it('skips the sign-in when the folder already holds one for the same server', async () => {
        const fake = createFakeBw({ statusText: JSON.stringify({ serverUrl: 'https://vault.bitwarden.eu/', status: 'locked' }) });

        await createCli(fake)
            .unlock();

        expect(commandNames(fake))
            .toEqual(['status', 'unlock --passwordenv BW_PASSWORD --raw', 'sync']);
    });

    it('signs out first when the folder holds a sign-in for another server', async () => {
        const fake = createFakeBw({ statusText: JSON.stringify({ serverUrl: null, status: 'locked' }) });

        await createCli(fake)
            .unlock();

        expect(commandNames(fake)
            .slice(0, 4))
            .toEqual(['status', 'logout', 'config server https://vault.bitwarden.eu', 'login --apikey']);
    });

    it('unlocks once and reuses the session for the next calls', async () => {
        const fake = createFakeBw();
        const cli = createCli(fake);

        await cli.unlock();
        await cli.getValue('item-1', 'password');
        await cli.getValue('item-1', 'totp');

        expect(commandNames(fake)
            .filter(name => name.startsWith('unlock')))
            .toHaveLength(1);
        expect(commandNames(fake)
            .slice(-2))
            .toEqual(['get password item-1', 'get totp item-1']);
        expect(fake.calls.at(-1)?.env.BW_SESSION)
            .toBe(SESSION_KEY);
    });

    it('locks the vault after ten idle minutes and unlocks again on the next use', async () => {
        const fake = createFakeBw({ statusText: JSON.stringify({ serverUrl: 'https://vault.bitwarden.eu', status: 'locked' }) });
        const cli = createCli(fake);

        await cli.unlock();
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);

        expect(commandNames(fake))
            .not.toContain('lock');

        await vi.advanceTimersByTimeAsync(60 * 1000);

        expect(commandNames(fake))
            .toContain('lock');

        await cli.getValue('item-1', 'password');

        expect(commandNames(fake)
            .filter(name => name.startsWith('unlock')))
            .toHaveLength(2);
    });

    it('moves the idle lock further away with each use', async () => {
        const fake = createFakeBw();
        const cli = createCli(fake);

        await cli.unlock();
        await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
        await cli.getValue('item-1', 'password');
        await vi.advanceTimersByTimeAsync(8 * 60 * 1000);

        expect(commandNames(fake))
            .not.toContain('lock');
    });

    it('reads only the login items and never keeps a user name or a password in the list', async () => {
        const fake = createFakeBw({
            items: [
                { id: 'a', name: 'GitHub', type: 1, login: { username: 'ana', password: 'fake-password-1', totp: 'JBSWY3DP', uris: [{ uri: 'https://github.com/login' }, { uri: '' }] } },
                { id: 'b', name: 'Card', type: 3, card: { number: '4111' } },
                { id: 'c', name: 'No uris', type: 1, login: { username: 'bo', password: 'fake-password-2' } },
                'not an item',
            ],
        });
        const items = await createCli(fake)
            .listLogins();

        expect(items)
            .toEqual([
                { id: 'a', name: 'GitHub', uris: ['https://github.com/login'], hasTotp: true },
                { id: 'c', name: 'No uris', uris: [], hasTotp: false },
            ]);
        expect(JSON.stringify(items)).not.toContain('fake-password');
    });

    it('reads a value with get and drops the final line break', async () => {
        const fake = createFakeBw();
        const value = await createCli(fake)
            .getValue('item-1', 'username');

        expect(value)
            .toBe('fake-value');
    });

    it('never puts the master password, the API secret or the session in an error', async () => {
        const leaking = new BitwardenRunError('failed', `Invalid ${ACCOUNT.masterPassword} for ${ACCOUNT.clientSecret} and ${ACCOUNT.clientId}\nsecond line`);
        const fake = createFakeBw({ failOn: 'unlock', failWith: leaking });
        const failure = await createCli(fake)
            .unlock()
            .catch((error: unknown) => error);

        expect(failure)
            .toBeInstanceOf(BitwardenError);

        const { message } = failure as BitwardenError;

        expect(message)
            .toContain('Bitwarden did not unlock');
        expect(message)
            .toContain('Bitwarden said: Invalid *** for *** and ***');
        expect(message).not.toContain(ACCOUNT.masterPassword);
        expect(message).not.toContain(ACCOUNT.clientSecret);
        expect(message).not.toContain('second line');
    });

    it('says a login was refused without any secret', async () => {
        const fake = createFakeBw({ failOn: 'login', failWith: new BitwardenRunError('failed', 'client_id or client_secret is incorrect') });
        const failure = await createCli(fake)
            .unlock()
            .catch((error: unknown) => error);

        expect((failure as BitwardenError).message)
            .toBe('Bitwarden refused the API key. Check the client ID and the client secret. Bitwarden said: client_id or client_secret is incorrect');
    });

    it('tells a timeout and a too big answer apart', async () => {
        const slow = createFakeBw({ failOn: 'status', failWith: new BitwardenRunError('timeout', '') });
        const big = createFakeBw({ failOn: 'status', failWith: new BitwardenRunError('too_big', '') });
        const slowFailure = await createCli(slow)
            .unlock()
            .catch((error: unknown) => error);
        const bigFailure = await createCli(big)
            .unlock()
            .catch((error: unknown) => error);

        expect((slowFailure as BitwardenError).message)
            .toContain('It took too long.');
        expect((bigFailure as BitwardenError).message)
            .toContain('The answer was too big.');
    });

    it('refuses an unlock that gives no session key', async () => {
        const fake = createFakeBw({ unlockOutput: 'Invalid master password.' });
        const failure = await createCli(fake)
            .unlock()
            .catch((error: unknown) => error);

        expect((failure as BitwardenError).message)
            .toContain('did not give a session');
    });

    it('drops the session when the sync fails', async () => {
        const fake = createFakeBw({ failOn: 'sync' });
        const cli = createCli(fake);

        await expect(cli.unlock())
            .rejects.toThrow('could not sync');
        expect(commandNames(fake))
            .toContain('lock');
    });

    it('signs out and forgets the key', async () => {
        const fake = createFakeBw();
        const cli = createCli(fake);

        await cli.unlock();
        await cli.logout();
        await cli.getValue('item-1', 'password');

        expect(commandNames(fake))
            .toContain('logout');
        expect(commandNames(fake)
            .filter(name => name.startsWith('unlock')))
            .toHaveLength(2);
    });

    it('runs the commands one at a time', async () => {
        let running = 0;
        let maxRunning = 0;
        const fake = createFakeBw();
        const slowRun = async (request: BitwardenRunRequest): Promise<string> => {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await Promise.resolve();

            const output = await fake.run(request);

            running -= 1;

            return output;
        };
        const cli = new BitwardenCli({ account: ACCOUNT, appDataDir: APP_DATA_DIR, runner: slowRun });

        await Promise.all([cli.getValue('a', 'password'), cli.getValue('b', 'password'), cli.listLogins()]);

        expect(maxRunning)
            .toBe(1);
    });
});
