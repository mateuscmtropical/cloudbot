import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAccountSpawn } from './FakeCodexAccountServer.ts';
import type { FakeAccountAnswers } from './FakeCodexAccountServer.ts';
import { signOutCodex } from './signOutCodex.ts';

function signOut(answers: FakeAccountAnswers): { done: Promise<void>; fake: ReturnType<typeof fakeAccountSpawn> } {
    const fake = fakeAccountSpawn(answers);
    const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-logout-')), 'codex-home');
    const done = signOutCodex({ codexPath: '/usr/local/bin/codex', codexHome: home, spawnFunction: fake.spawnFunction, signalProcess: () => undefined });

    return { done, fake };
}

describe('signOutCodex', () => {
    it('logs out and checks that the bot is signed out', async () => {
        const { done, fake } = signOut([
            ['account/logout', () => ({ result: {} })],
            ['account/read', () => ({ result: { account: null, requiresOpenaiAuth: true } })],
        ]);

        await expect(done).resolves.toBeUndefined();
        expect(fake.servers.flatMap(server => server.methods()))
            .toEqual(['initialize', 'initialized', 'account/logout', 'initialize', 'initialized', 'account/read']);
    });

    it('fails when the bot is still signed in afterwards', async () => {
        const { done } = signOut([
            ['account/logout', () => ({ result: {} })],
            ['account/read', () => ({ result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } })],
        ]);

        await expect(done).rejects.toThrow('Could not sign out of Codex');
    });

    it('fails when the logout answers with an error', async () => {
        const { done } = signOut([['account/logout', () => ({ error: { code: -1, message: 'no' } })]]);

        await expect(done).rejects.toThrow('Could not sign out of Codex');
    });
});
