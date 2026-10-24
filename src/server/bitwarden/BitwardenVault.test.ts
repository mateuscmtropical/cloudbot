import { mkdtempSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BitwardenCli } from './BitwardenCli.ts';
import type { BitwardenAccount, BitwardenRunRequest } from './BitwardenCli.ts';
import { BitwardenVault, APPROVAL_MS } from './BitwardenVault.ts';

const ACCOUNT: BitwardenAccount = {
    serverUrl: 'https://vault.bitwarden.com',
    clientId: 'user.11111111-2222-3333-4444-555555555555',
    clientSecret: 'fakeclientsecret0123456789',
    masterPassword: 'fake master password',
};

describe('BitwardenVault', () => {
    let baseDir = '';
    let saved: BitwardenAccount | undefined;
    let clock = 1_000;
    let commands: string[][] = [];
    let appDataDirs: string[] = [];

    function createVault(): BitwardenVault {
        return new BitwardenVault({
            accounts: {
                read: () => saved,
                save: (_botId, account) => {
                    saved = account;
                },
                forget: () => {
                    saved = undefined;
                },
            },
            baseDir,
            now: () => clock,
            createCli: (account, appDataDir) => {
                appDataDirs.push(appDataDir);

                const runner = (request: BitwardenRunRequest): Promise<string> => {
                    commands.push(request.args);

                    return Promise.resolve(request.args[0] === 'unlock' ? 'fake-session-key-0123456789abcdef' : JSON.stringify({ status: 'unauthenticated' }));
                };

                return new BitwardenCli({ account, appDataDir, runner });
            },
        });
    }

    beforeEach(() => {
        baseDir = mkdtempSync(join(tmpdir(), 'cloudbot-bw-'));
        saved = undefined;
        clock = 1_000;
        commands = [];
        appDataDirs = [];
    });

    afterEach(() => {
        rmSync(baseDir, { recursive: true, force: true });
    });

    it('says what is saved without any secret', async () => {
        const vault = createVault();

        expect(vault.status('bot-1'))
            .toEqual({ configured: false, serverUrl: '' });
        expect(vault.isConfigured('bot-1'))
            .toBe(false);

        await vault.save('bot-1', ACCOUNT);

        expect(vault.status('bot-1'))
            .toEqual({ configured: true, serverUrl: 'https://vault.bitwarden.com' });
        expect(JSON.stringify(vault.status('bot-1'))).not.toContain('fake master password');
    });

    it('refuses to test or read when nothing is saved', async () => {
        const vault = createVault();

        await expect(vault.test('bot-1'))
            .rejects.toThrow('not set up');
        await expect(vault.listLogins('bot-1'))
            .rejects.toThrow('not set up');
    });

    it('gives each bot its own private folder named by a hash', async () => {
        const vault = createVault();

        await vault.save('bot-1', ACCOUNT);
        await vault.test('bot-1');

        const [folder] = appDataDirs;

        expect(folder?.startsWith(baseDir))
            .toBe(true);
        expect(folder).not.toContain('bot-1');
        expect(existsSync(folder ?? ''))
            .toBe(true);

        // Windows has no unix mode bits. The check matters on the Linux image.
        if (process.platform !== 'win32') {
            expect(statSync(folder ?? '').mode & 0o777)
                .toBe(0o700);
        }
    });

    it('reuses the CLI and its session until the saved account changes', async () => {
        const vault = createVault();

        await vault.save('bot-1', ACCOUNT);
        await vault.test('bot-1');
        await vault.listLogins('bot-1')
            .catch(() => undefined);

        expect(appDataDirs)
            .toHaveLength(1);
        expect(commands.filter(args => args[0] === 'unlock'))
            .toHaveLength(1);

        await vault.save('bot-1', { ...ACCOUNT, masterPassword: 'another fake password' });
        await vault.test('bot-1');

        expect(appDataDirs)
            .toHaveLength(2);
    });

    it('forgets by signing out, removing the folder and dropping the approvals', async () => {
        const vault = createVault();

        await vault.save('bot-1', ACCOUNT);
        await vault.test('bot-1');
        vault.rememberApproval('bot-1', 'item-1', 'https://github.com');
        await vault.forget('bot-1');

        expect(commands.some(args => args[0] === 'logout'))
            .toBe(true);
        expect(saved)
            .toBeUndefined();
        expect(readdirSync(baseDir))
            .toEqual([]);
        expect(vault.hasApproval('bot-1', 'item-1', 'https://github.com'))
            .toBe(false);
    });

    it('remembers an approval for one bot, login and origin for ten minutes', () => {
        const vault = createVault();

        vault.rememberApproval('bot-1', 'item-1', 'https://github.com');

        expect(vault.hasApproval('bot-1', 'item-1', 'https://github.com'))
            .toBe(true);
        expect(vault.hasApproval('bot-2', 'item-1', 'https://github.com'))
            .toBe(false);
        expect(vault.hasApproval('bot-1', 'item-2', 'https://github.com'))
            .toBe(false);
        expect(vault.hasApproval('bot-1', 'item-1', 'https://gist.github.com'))
            .toBe(false);

        clock += APPROVAL_MS - 1;

        expect(vault.hasApproval('bot-1', 'item-1', 'https://github.com'))
            .toBe(true);

        clock += 1;

        expect(vault.hasApproval('bot-1', 'item-1', 'https://github.com'))
            .toBe(false);
    });
});
