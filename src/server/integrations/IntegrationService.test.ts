import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BotSecret } from '../secrets/BotSecrets.ts';
import { BotStore } from '../store/BotStore.ts';
import { IntegrationStore } from '../store/IntegrationStore.ts';
import type { OpenedDatabase } from '../store/openDatabase.ts';
import { openDatabase } from '../store/openDatabase.ts';
import { IntegrationError, hashContent } from './integrationFiles.ts';
import { IntegrationService, MAX_INTEGRATIONS_PER_BOT, MAX_SCRIPT_BYTES } from './IntegrationService.ts';
import { INTEGRATION_WRAPPER, runIntegrationProcess } from './runIntegrationProcess.ts';
import type { ProcessRequest, ProcessResult } from './runIntegrationProcess.ts';

const IS_WINDOWS = process.platform === 'win32';

const KEY = 'sk-live-test-value';
const SECRET_NAME = 'STORE_API_KEY';
const SITE = 'https://store.example';
// A script that prints the key in plain and in base64, which the bot might write on purpose.
const LEAK_SCRIPT = 'const k = process.env.STORE_API_KEY; console.log("key " + k); console.log(Buffer.from(k).toString("base64"));';
const NO_OUTPUT: ProcessResult = { exitCode: 0, output: Buffer.alloc(0), timedOut: false, truncated: false };
const POSTED = 'console.log("posted")';

// The real wrapper runs under bash, without sudo. The sudo line is checked by the argv test in runIntegrationProcess.test.ts.
// The test user shares its process limit with the test runner, so no process limit is set here.
function runOnHost(request: ProcessRequest): ReturnType<typeof runIntegrationProcess> {
    const wrapperArgs = ['-c', INTEGRATION_WRAPPER, 'cloudbot-integration', '', request.secretName ?? '', request.command, ...request.args];

    return runIntegrationProcess({ ...request, command: 'bash', args: wrapperArgs, env: { PATH: process.env['PATH'] ?? '' } });
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

describe('IntegrationService card and rules', () => {
    let opened: OpenedDatabase;
    let botId: string;
    let workspace: string;
    let service: IntegrationService;
    let secrets: Map<string, BotSecret>;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
        workspace = await mkdtemp(join(tmpdir(), 'integrations-card-'));
        secrets = new Map([[`${botId}:${SECRET_NAME}`, { site: SITE, value: KEY }]]);
        service = new IntegrationService({
            store: new IntegrationStore(opened.db),
            secrets: { read: (id, name) => secrets.get(`${id}:${name}`) },
            workspaceFor: () => workspace,
            run: () => Promise.resolve(NO_OUTPUT),
            cleanup: () => Promise.resolve(),
        });
        await writeFile(join(workspace, 'post.js'), POSTED);
    });

    afterEach(() => {
        opened.close();
    });

    it('shows the name, the command, the secret with its site, the hash and the whole script on the card', async () => {
        const hash = hashContent(Buffer.from(POSTED));
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'post.js', command: 'node', secretName: SECRET_NAME, sha256: hash });
        const text = card.ok ? card.text : '';

        expect(card.ok)
            .toBe(true);
        expect(text)
            .toContain('Name: "store"');
        expect(text)
            .toContain('Entry file: "post.js"');
        expect(text)
            .toContain('Command: node');
        expect(text)
            .toContain(`Secret: ${SECRET_NAME}, for ${SITE}`);
        expect(text)
            .toContain(`sha256: ${hash}`);
        expect(text)
            .toContain(POSTED);
        expect(text)
            .not.toContain(KEY);
    });

    it('merges an update over the stored record, so the card shows the stored entry file and its script', async () => {
        const hash = hashContent(Buffer.from(POSTED));

        await service.register(botId, { name: 'store', entryPath: 'post.js', command: 'node', secretName: undefined, sha256: hash });

        const card = await service.describeChange(botId, 'update', { name: 'store', entryPath: undefined, command: undefined, secretName: undefined, sha256: hash });
        const text = card.ok ? card.text : '';

        expect(card.ok)
            .toBe(true);
        expect(text)
            .toContain(POSTED);
        expect(text)
            .toContain('Entry file: "post.js"');
    });

    it('refuses an update card for an integration that does not exist', async () => {
        const card = await service.describeChange(botId, 'update', { name: 'missing', entryPath: undefined, command: undefined, secretName: undefined, sha256: 'a'.repeat(64) });

        expect(card)
            .toEqual({ ok: false, reason: 'There is no integration named "missing".' });
    });

    it('refuses a card when the file does not match the hash in the request', async () => {
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'post.js', command: 'node', secretName: undefined, sha256: 'a'.repeat(64) });
        const reason = card.ok ? '' : card.reason;

        expect(card.ok)
            .toBe(false);
        expect(reason)
            .toContain('does not match the sha256 in the request');
    });

    it('refuses a card when the entry file cannot be read', async () => {
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'missing.js', command: 'node', secretName: undefined, sha256: 'a'.repeat(64) });
        const reason = card.ok ? '' : card.reason;

        expect(card.ok)
            .toBe(false);
        expect(reason)
            .toContain('The script could not be read');
    });

    it('refuses a card for a script over the size limit', async () => {
        const big = 'x'.repeat(MAX_SCRIPT_BYTES + 1);

        await writeFile(join(workspace, 'big.js'), big);
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'big.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(big)) });
        const reason = card.ok ? '' : card.reason;

        expect(card.ok)
            .toBe(false);
        expect(reason)
            .toContain(`larger than ${String(MAX_SCRIPT_BYTES)} bytes`);
    });

    it('shows a script at the size limit in full', async () => {
        const exact = 'x'.repeat(MAX_SCRIPT_BYTES);

        await writeFile(join(workspace, 'exact.js'), exact);
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'exact.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(exact)) });
        const text = card.ok ? card.text : '';

        expect(text)
            .toContain(exact);
    });

    it('refuses a script with a bidi override, which could hide its content', async () => {
        const hidden = 'console.log("ok");‮// hidden';
        const hash = hashContent(Buffer.from(hidden));

        await writeFile(join(workspace, 'bidi.js'), hidden);
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'bidi.js', command: 'node', secretName: undefined, sha256: hash });

        expect(card.ok)
            .toBe(false);
        await expect(service.register(botId, { name: 'store', entryPath: 'bidi.js', command: 'node', secretName: undefined, sha256: hash }))
            .rejects.toThrow('control, bidi or zero-width');
    });

    it('refuses a control character, but keeps tabs and line breaks', async () => {
        const withBell = 'console.log(1);\u0007';

        await writeFile(join(workspace, 'bell.js'), withBell);
        await expect(service.register(botId, { name: 'store', entryPath: 'bell.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(withBell)) }))
            .rejects.toThrow('control, bidi or zero-width');

        const withTabs = 'console.log(1);\n\tconsole.log(2);\n';

        await writeFile(join(workspace, 'tabs.js'), withTabs);
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'tabs.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(withTabs)) });

        expect(card.ok)
            .toBe(true);
    });

    it('refuses a lone carriage return, which ends a comment early in JavaScript and Python', async () => {
        const lone = 'console.log(1); // shown\rconsole.log("run")\n';

        await writeFile(join(workspace, 'cr.js'), lone);
        const card = await service.describeChange(botId, 'create', { name: 'store', entryPath: 'cr.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(lone)) });
        const reason = card.ok ? '' : card.reason;

        expect(card.ok)
            .toBe(false);
        expect(reason)
            .toContain('LF line endings');
    });

    it('refuses CRLF line endings, and asks for LF', async () => {
        const crlf = 'console.log(1);\r\nconsole.log(2);\r\n';

        await writeFile(join(workspace, 'crlf.js'), crlf);
        await expect(service.register(botId, { name: 'store', entryPath: 'crlf.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(crlf)) }))
            .rejects.toThrow('LF line endings');
    });

    it('refuses a line separator, U+2028', async () => {
        const separator = 'console.log(1); // shown console.log("run")\n';

        await writeFile(join(workspace, 'ls.js'), separator);
        await expect(service.register(botId, { name: 'store', entryPath: 'ls.js', command: 'node', secretName: undefined, sha256: hashContent(Buffer.from(separator)) }))
            .rejects.toThrow('control, bidi or zero-width');
    });

    it('refuses a register whose hash does not match the file', async () => {
        await expect(service.register(botId, { name: 'post', entryPath: 'post.js', command: 'node', secretName: undefined, sha256: 'b'.repeat(64) }))
            .rejects.toThrow('does not match the sha256');
    });

    it('refuses a sha256 that is not 64 hex characters', async () => {
        await expect(service.register(botId, { name: 'post', entryPath: 'post.js', command: 'node', secretName: undefined, sha256: 'short' }))
            .rejects.toThrow('64 hex characters');
    });

    it('refuses secret names that the environment or the interpreter reads', async () => {
        const hash = hashContent(Buffer.from(POSTED));
        const names = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'PYTHONPATH', 'IFS', 'BASH_FUNC_x'];

        await names.reduce(async (previous, name) => {
            await previous;
            await expect(service.register(botId, { name: 'store', entryPath: 'post.js', command: 'node', secretName: name, sha256: hash }))
                .rejects.toBeInstanceOf(IntegrationError);
        }, Promise.resolve());
    });

    it('clears the secret when an update gives an empty name or null', async () => {
        const hash = hashContent(Buffer.from(POSTED));

        await service.register(botId, { name: 'store', entryPath: 'post.js', command: 'node', secretName: SECRET_NAME, sha256: hash });
        const cleared = await service.update(botId, { name: 'store', entryPath: undefined, command: undefined, secretName: '', sha256: hash });

        expect(cleared.secretName)
            .toBeUndefined();

        await service.update(botId, { name: 'store', entryPath: undefined, command: undefined, secretName: SECRET_NAME, sha256: hash });
        const removed = await service.update(botId, { name: 'store', entryPath: undefined, command: undefined, secretName: null, sha256: hash });

        expect(removed.secretName)
            .toBeUndefined();
    });

    it('keeps the secret when an update leaves it out', async () => {
        const hash = hashContent(Buffer.from(POSTED));

        await service.register(botId, { name: 'store', entryPath: 'post.js', command: 'node', secretName: SECRET_NAME, sha256: hash });
        const kept = await service.update(botId, { name: 'store', entryPath: undefined, command: undefined, secretName: undefined, sha256: hash });

        expect(kept.secretName)
            .toBe(SECRET_NAME);
    });

    it('refuses an update that brings a script over the size limit', async () => {
        const hash = hashContent(Buffer.from(POSTED));
        const big = 'x'.repeat(MAX_SCRIPT_BYTES + 1);

        await service.register(botId, { name: 'store', entryPath: 'post.js', command: 'node', secretName: undefined, sha256: hash });
        await writeFile(join(workspace, 'post.js'), big);

        await expect(service.update(botId, { name: 'store', entryPath: undefined, command: undefined, secretName: undefined, sha256: hashContent(Buffer.from(big)) }))
            .rejects.toThrow('larger than');
    });
});

describe('IntegrationService runs', () => {
    let opened: OpenedDatabase;
    let store: IntegrationStore;
    let botId: string;
    let workspace: string;
    let secrets: Map<string, BotSecret>;
    let cleanups: number;

    beforeEach(async () => {
        opened = await openDatabase(':memory:');
        const bot = await new BotStore(opened.db)
            .create({ name: 'Ana', title: 'Assistant', description: '' });

        botId = bot.id;
        store = new IntegrationStore(opened.db);
        workspace = await mkdtemp(join(tmpdir(), 'integrations-'));
        cleanups = 0;
        secrets = new Map([[`${botId}:${SECRET_NAME}`, { site: SITE, value: KEY }]]);
        await writeFile(join(workspace, 'post.js'), POSTED);
    });

    afterEach(() => {
        opened.close();
    });

    function buildService(run: (request: ProcessRequest) => Promise<ProcessResult>): IntegrationService {
        return new IntegrationService({
            store,
            secrets: { read: (id, name) => secrets.get(`${id}:${name}`) },
            workspaceFor: () => workspace,
            run,
            cleanup: () => {
                cleanups += 1;

                return Promise.resolve();
            },
        });
    }

    async function registerFile(service: IntegrationService, name: string, file: string, secretName?: string): Promise<void> {
        const sha256 = hashContent(await readFile(join(workspace, file)));

        await service.register(botId, { name, entryPath: file, command: 'node', secretName, sha256 });
    }

    it.skipIf(IS_WINDOWS)('redacts the key from the output, and the run log keeps no key either', async () => {
        await writeFile(join(workspace, 'leak.js'), LEAK_SCRIPT);
        const service = buildService(runOnHost);

        await registerFile(service, 'store', 'leak.js', SECRET_NAME);

        const outcome = await service.run(botId, 'store');
        const record = await store.findByName(botId, 'store');
        const logged = await store.listRuns(record?.id ?? '');

        expect(outcome.output)
            .not.toContain(KEY);
        expect(outcome.output)
            .not.toContain(Buffer.from(KEY)
                .toString('base64'));
        expect(outcome.output)
            .toContain('[redacted]');
        expect(JSON.stringify(logged))
            .not.toContain(KEY);
    });

    it.skipIf(IS_WINDOWS)('refuses to run a file that changed since it was registered, until the update is registered', async () => {
        const service = buildService(runOnHost);

        await registerFile(service, 'post', 'post.js');
        await writeFile(join(workspace, 'post.js'), 'console.log("changed")');

        await expect(service.run(botId, 'post'))
            .rejects.toThrow('The entry file changed since it was last registered');

        const sha256 = hashContent(await readFile(join(workspace, 'post.js')));

        await service.update(botId, { name: 'post', entryPath: undefined, command: undefined, secretName: undefined, sha256 });

        expect((await service.run(botId, 'post')).output)
            .toContain('changed');
    });

    it('cleans up before and after every run, also when the run fails', async () => {
        const service = buildService(() => Promise.reject(new Error('spawn failed')));

        await registerFile(service, 'post', 'post.js');

        await expect(service.run(botId, 'post'))
            .rejects.toThrow('could not be started');
        expect(cleanups)
            .toBe(2);
    });

    it('runs one integration at a time', async () => {
        const events: string[] = [];
        const service = buildService(async () => {
            events.push('start');
            await sleep(30);
            events.push('end');

            return NO_OUTPUT;
        });

        await registerFile(service, 'post', 'post.js');
        await Promise.all([service.run(botId, 'post'), service.run(botId, 'post')]);

        expect(events)
            .toEqual(['start', 'end', 'start', 'end']);
    });

    it.skipIf(IS_WINDOWS)('keeps the last 20 runs of an integration', async () => {
        const service = buildService(runOnHost);

        await registerFile(service, 'post', 'post.js');

        const runs = Array.from({ length: 22 }, () => 'post');

        await runs.reduce(async (previous, name) => {
            await previous;
            await service.run(botId, name);
        }, Promise.resolve());

        const record = await store.findByName(botId, 'post');

        expect(await store.listRuns(record?.id ?? ''))
            .toHaveLength(20);
    }, 120 * 1000);

    it('allows only the set number of integrations for one bot', async () => {
        await writeFile(join(workspace, 'post.js'), 'console.log(1)');
        const service = buildService(() => Promise.resolve(NO_OUTPUT));
        const sha256 = hashContent(await readFile(join(workspace, 'post.js')));
        const names = Array.from({ length: MAX_INTEGRATIONS_PER_BOT }, (_unused, index) => `item-${String(index)}`);

        await names.reduce(async (previous, name) => {
            await previous;
            await service.register(botId, { name, entryPath: 'post.js', command: 'node', secretName: undefined, sha256 });
        }, Promise.resolve());

        await expect(service.register(botId, { name: 'one-more', entryPath: 'post.js', command: 'node', secretName: undefined, sha256 }))
            .rejects.toThrow('at most');
    });
});
