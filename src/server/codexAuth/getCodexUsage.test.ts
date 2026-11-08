import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAccountSpawn, missingSpawn } from './FakeCodexAccountServer.ts';
import type { FakeAccountAnswer } from './FakeCodexAccountServer.ts';
import { getCodexUsage } from './getCodexUsage.ts';

function readUsage(answer: FakeAccountAnswer): { usage: ReturnType<typeof getCodexUsage>; fake: ReturnType<typeof fakeAccountSpawn> } {
    const fake = fakeAccountSpawn([['account/rateLimits/read', answer]]);
    const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-usage-')), 'codex-home');
    const usage = getCodexUsage({ codexPath: '/usr/local/bin/codex', codexHome: home, spawnFunction: fake.spawnFunction, signalProcess: () => undefined });

    return { usage, fake };
}

describe('getCodexUsage', () => {
    it('returns the rate limits answer and closes the app server', async () => {
        const result = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 } } };
        const { usage, fake } = readUsage(() => ({ result }));

        await expect(usage).resolves.toEqual(result);
        expect(fake.servers[0]?.sent.find(message => message.method === 'account/rateLimits/read')?.params)
            .toEqual({ excludeResetCreditDetails: true });
        expect(fake.servers[0]?.stdin.writableEnded)
            .toBe(true);
    });

    it('fails on an error answer', async () => {
        const { usage } = readUsage(() => ({ error: { code: -1, message: 'not signed in' } }));

        await expect(usage).rejects.toThrow('Could not read the Codex usage.');
    });

    it('fails when Codex is missing', async () => {
        const home = join(mkdtempSync(join(tmpdir(), 'cloudbot-codex-usage-')), 'codex-home');
        const usage = getCodexUsage({ codexPath: '/missing/codex', codexHome: home, spawnFunction: missingSpawn(), signalProcess: () => undefined });

        await expect(usage).rejects.toThrow();
    });
});
