import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docker', 'cloudbot-read-memory');
const WORKSPACE_ROOT_LINE = 'WORKSPACE_ROOT=/var/lib/cloudbot-workspaces';

interface ScriptResult {
    status: number | null;
    stdout: string;
}

function runScript(args: string[], scriptPath = SCRIPT_PATH): ScriptResult {
    const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8' });

    return { status: result.status, stdout: result.stdout };
}

// The helper refuses every argument that is not one plain bot id, before it touches any file.
describe.skipIf(IS_WINDOWS)('docker/cloudbot-read-memory', () => {
    it('refuses a path, an empty id and a wrong number of arguments', () => {
        const refused = [['../etc'], ['bot/other'], [''], [], ['bot-1', 'bot-2']].map(args => runScript(args).status);

        expect(refused)
            .toEqual([2, 2, 2, 2, 2]);
    });
});

// Runs a copy of the script whose workspace root is a temporary folder.
describe.skipIf(IS_WINDOWS)('docker/cloudbot-read-memory reading', () => {
    const TEMPORARY: string[] = [];

    afterEach(async () => {
        const removals = TEMPORARY.splice(0)
            .map(folder => rm(folder, { recursive: true, force: true }));

        await Promise.all(removals);
    });

    async function sandbox(): Promise<{ workspace: string; scriptCopy: string }> {
        const folder = await mkdtemp(join(tmpdir(), 'cloudbot-read-memory-'));

        TEMPORARY.push(folder);

        const root = join(folder, 'workspaces');
        const workspace = join(root, 'bot_1');
        const scriptCopy = join(folder, 'cloudbot-read-memory');
        const script = await readFile(SCRIPT_PATH, 'utf8');

        await mkdir(workspace, { recursive: true });
        await writeFile(scriptCopy, script.replace(WORKSPACE_ROOT_LINE, `WORKSPACE_ROOT=${root}`));

        return { workspace, scriptCopy };
    }

    it('prints MEMORY.md and nothing for a missing file', async () => {
        const { workspace, scriptCopy } = await sandbox();

        expect(runScript(['bot_1'], scriptCopy))
            .toEqual({ status: 0, stdout: '' });

        await writeFile(join(workspace, 'MEMORY.md'), 'Favorite color: teal');

        expect(runScript(['bot_1'], scriptCopy))
            .toEqual({ status: 0, stdout: 'Favorite color: teal' });
    });

    it('renames an old CLAUDE.md to MEMORY.md and prints it', async () => {
        const { workspace, scriptCopy } = await sandbox();

        await writeFile(join(workspace, 'CLAUDE.md'), 'old notes');

        expect(runScript(['bot_1'], scriptCopy))
            .toEqual({ status: 0, stdout: 'old notes' });
        expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8'))
            .toBe('old notes');
    });

    it('prints nothing for a link', async () => {
        const { workspace, scriptCopy } = await sandbox();
        const outside = join(dirname(scriptCopy), 'secret.txt');

        await writeFile(outside, 'SECRET-OUTSIDE-TEXT');
        await symlink(outside, join(workspace, 'MEMORY.md'));

        expect(runScript(['bot_1'], scriptCopy))
            .toEqual({ status: 0, stdout: '' });
    });

    it('stops one byte past 64 KB', async () => {
        const { workspace, scriptCopy } = await sandbox();

        await writeFile(join(workspace, 'MEMORY.md'), 'a'.repeat(70 * 1024));

        expect(runScript(['bot_1'], scriptCopy).stdout.length)
            .toBe(64 * 1024 + 1);
    });
});
