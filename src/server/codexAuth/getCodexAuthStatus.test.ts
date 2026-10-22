import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAccountSpawn, missingSpawn } from './FakeCodexAccountServer.ts';
import type { FakeAccountAnswer } from './FakeCodexAccountServer.ts';
import { getCodexAuthStatus } from './getCodexAuthStatus.ts';

function readStatus(answer: FakeAccountAnswer): { status: ReturnType<typeof getCodexAuthStatus>; fake: ReturnType<typeof fakeAccountSpawn> } {
    const fake = fakeAccountSpawn([['account/read', answer]]);
    const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-status-')), 'codex-home');
    const status = getCodexAuthStatus({ codexPath: '/usr/local/bin/codex', codexHome: home, spawnFunction: fake.spawnFunction, signalProcess: () => undefined });

    return { status, fake };
}

describe('getCodexAuthStatus', () => {
    it('reports a signed out bot and asks for no token refresh', async () => {
        const { status, fake } = readStatus(() => ({ result: { account: null, requiresOpenaiAuth: true } }));

        await expect(status).resolves.toEqual({ isLoggedIn: false });
        expect(fake.servers[0]?.sent.find(message => message.method === 'account/read')?.params)
            .toEqual({ refreshToken: false });
        expect(fake.servers[0]?.stdin.writableEnded)
            .toBe(true);
    });

    it('reports the account type and nothing else', async () => {
        const { status } = readStatus(() => ({ result: { account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus' }, requiresOpenaiAuth: true } }));

        await expect(status).resolves.toEqual({ isLoggedIn: true, method: 'chatgpt' });
    });

    it('fails on an error answer or a strange shape', async () => {
        await expect(readStatus(() => ({ error: { code: -1, message: 'no' } })).status).rejects.toThrow('Could not check Codex sign-in status');
        await expect(readStatus(() => ({ result: {} })).status).rejects.toThrow('Could not check Codex sign-in status');
        await expect(readStatus(() => ({ result: { account: { email: 'x' } } })).status).rejects.toThrow('Could not check Codex sign-in status');
    });

    it('fails when Codex is missing', async () => {
        const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-status-')), 'codex-home');
        const status = getCodexAuthStatus({ codexPath: '/missing/codex', codexHome: home, spawnFunction: missingSpawn(), signalProcess: () => undefined });

        await expect(status).rejects.toThrow('Could not check Codex sign-in status');
    });
});
