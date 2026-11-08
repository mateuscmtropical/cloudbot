import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('docker', 'provider-usage.js');
// Replaces fetch before the script starts, so no test reaches the network. It logs the call and answers with a fixture.
const FETCH_STUB = `
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url, init) => {
    appendFileSync(process.env.FAKE_FETCH_LOG, JSON.stringify({ url, headers: init.headers }) + '\\n');

    return new Response(process.env.FAKE_FETCH_BODY, { status: Number(process.env.FAKE_FETCH_STATUS) });
};
`;

interface ScriptResult {
    code: number;
    stdout: string;
    calls: { url: string; headers: Record<string, string> }[];
}

function runScript(provider: string, files: Record<string, string>, answer: { status?: number; body?: string } = {}): Promise<ScriptResult> {
    const folder = mkdtempSync(join(tmpdir(), 'cloudbot-usage-script-'));
    const home = join(folder, 'home');
    const log = join(folder, 'calls.log');
    const stub = join(folder, 'stub.mjs');

    writeFileSync(stub, FETCH_STUB);
    writeFileSync(log, '');
    Object.entries(files)
        .forEach(([name, text]) => {
            const file = join(home, name);

            mkdirSync(join(file, '..'), { recursive: true });
            writeFileSync(file, text);
        });

    const environment = { HOME: home, FAKE_FETCH_LOG: log, FAKE_FETCH_STATUS: String(answer.status ?? 200), FAKE_FETCH_BODY: answer.body ?? '{"ok":true}' };

    return new Promise((done) => {
        execFile(process.execPath, ['--import', pathToFileURL(stub).href, SCRIPT, provider], { env: environment }, (error, stdout) => {
            const lines = readFileSync(log, 'utf8')
                .split('\n')
                .filter(line => line !== '');
            const calls = lines.map(line => JSON.parse(line) as ScriptResult['calls'][number]);
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;

            done({ code, stdout, calls });
        });
    });
}

// What the Copilot CLI writes when it has no keychain: comment lines first, then the config with the token.
const COPILOT_CONFIG = [
    '// User settings belong in settings.json.',
    '// This file is managed automatically.',
    JSON.stringify({ lastLoggedInUser: { host: 'https://github.com', login: 'octocat' }, copilot_tokens: { 'https://github.com:octocat': 'fake-token' } }, null, 2),
].join('\n');

function kimiCredentials(expiresAt: number): string {
    return JSON.stringify({ access_token: 'fake-kimi-token', refresh_token: 'fake-refresh', expires_at: expiresAt, token_type: 'Bearer', expires_in: 900 });
}

describe('docker/provider-usage.js', () => {
    it('calls the Copilot usage endpoint with the token of the config file and prints the body', async () => {
        const result = await runScript('copilot', { '.copilot/config.json': COPILOT_CONFIG }, { body: '{"quota_snapshots":{}}' });

        expect(result)
            .toEqual({
                code: 0,
                stdout: '{"quota_snapshots":{}}',
                calls: [{ url: 'https://api.github.com/copilot_internal/user', headers: { Authorization: 'Bearer fake-token', Accept: 'application/json' } }],
            });
    });

    it('does nothing for Copilot without a token or on another GitHub host', async () => {
        const none = await runScript('copilot', { '.copilot/config.json': '{ "loggedInUsers": [] }' });
        const enterprise = await runScript('copilot', { '.copilot/config.json': COPILOT_CONFIG.replace('"https://github.com"', '"https://git.example.com"') });
        const missing = await runScript('copilot', {});

        expect([none, enterprise, missing].map(result => [result.code, result.stdout, result.calls.length]))
            .toEqual([[1, '', 0], [1, '', 0], [1, '', 0]]);
    });

    it('calls the Kimi usage endpoint with a token that has time left', async () => {
        const soon = Math.floor(Date.now() / 1000) + 600;
        const result = await runScript('kimi', { '.kimi-code/credentials/kimi-code.json': kimiCredentials(soon) });

        expect(result.code)
            .toBe(0);
        expect(result.calls)
            .toEqual([{ url: 'https://api.kimi.com/coding/v1/usages', headers: { Authorization: 'Bearer fake-kimi-token', Accept: 'application/json' } }]);
    });

    it('does not use an expired Kimi token, since only Kimi Code refreshes it', async () => {
        const past = Math.floor(Date.now() / 1000) - 60;
        const result = await runScript('kimi', { '.kimi-code/credentials/kimi-code.json': kimiCredentials(past) });

        expect([result.code, result.calls.length])
            .toEqual([1, 0]);
    });

    it('prints nothing and fails when the endpoint refuses', async () => {
        const result = await runScript('copilot', { '.copilot/config.json': COPILOT_CONFIG }, { status: 401, body: '{"message":"Bad credentials"}' });

        expect([result.code, result.stdout])
            .toEqual([1, '']);
    });

    it('refuses a provider it does not know', async () => {
        const result = await runScript('cursor', {});

        expect(result.code)
            .toBe(2);
    });
});
