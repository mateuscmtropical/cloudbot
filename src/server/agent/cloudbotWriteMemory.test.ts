import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docker', 'cloudbot-write-memory');
const WORKSPACE_ROOT_LINE = 'WORKSPACE_ROOT=/var/lib/cloudbot-workspaces';

interface Sandbox {
    workspace: string;
    scriptCopy: string;
}

function runScript(scriptPath: string, args: string[], input: string): number | null {
    return spawnSync('bash', [scriptPath, ...args], { input }).status;
}

// Runs a copy of the script whose workspace root is a temporary folder.
describe.skipIf(process.platform === 'win32')('docker/cloudbot-write-memory', () => {
    const TEMPORARY: string[] = [];

    afterEach(async () => {
        const removals = TEMPORARY.splice(0)
            .map(folder => rm(folder, { recursive: true, force: true }));

        await Promise.all(removals);
    });

    async function sandbox(): Promise<Sandbox> {
        const folder = await mkdtemp(join(tmpdir(), 'cloudbot-write-memory-'));

        TEMPORARY.push(folder);

        const root = join(folder, 'workspaces');
        const workspace = join(root, 'bot_1');
        const scriptCopy = join(folder, 'cloudbot-write-memory');
        const script = await readFile(SCRIPT_PATH, 'utf8');

        await mkdir(workspace, { recursive: true });
        await writeFile(scriptCopy, script.replace(WORKSPACE_ROOT_LINE, `WORKSPACE_ROOT=${root}`));

        return { workspace, scriptCopy };
    }

    it('refuses a path, an empty id and a wrong number of arguments', () => {
        const refused = [['../etc'], ['bot/other'], [''], [], ['bot-1', 'bot-2']].map(args => runScript(SCRIPT_PATH, args, ''));

        expect(refused)
            .toEqual([2, 2, 2, 2, 2]);
    });

    it('replaces the file with stdin, with group write, and leaves nothing else', async () => {
        const { workspace, scriptCopy } = await sandbox();
        const memoryPath = join(workspace, 'MEMORY.md');

        await writeFile(memoryPath, 'old', { mode: 0o600 });

        expect(runScript(scriptCopy, ['bot_1'], 'new notes'))
            .toBe(0);
        expect(await readFile(memoryPath, 'utf8'))
            .toBe('new notes');

        const info = await stat(memoryPath);

        expect(info.mode & 0o777)
            .toBe(0o660);
        expect(await readdir(workspace))
            .toEqual(['MEMORY.md']);
    });

    it('replaces a link without writing through it', async () => {
        const { workspace, scriptCopy } = await sandbox();
        const outside = join(dirname(scriptCopy), 'outside.txt');

        await writeFile(outside, 'keep me');
        await symlink(outside, join(workspace, 'MEMORY.md'));

        expect(runScript(scriptCopy, ['bot_1'], 'new notes'))
            .toBe(0);
        expect(await readFile(outside, 'utf8'))
            .toBe('keep me');
    });

    it('refuses more than 64 KB and keeps the old file', async () => {
        const { workspace, scriptCopy } = await sandbox();

        await writeFile(join(workspace, 'MEMORY.md'), 'old');

        const tooLong = 'x'.repeat(65_537);

        expect(runScript(scriptCopy, ['bot_1'], tooLong))
            .toBe(3);
        expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8'))
            .toBe('old');
        expect(await readdir(workspace))
            .toEqual(['MEMORY.md']);
    });
});
