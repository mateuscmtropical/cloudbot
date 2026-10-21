import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const IS_WINDOWS = process.platform === 'win32';
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docker', 'cloudbot-remove-workspace');
const WORKSPACE_ROOT_LINE = 'WORKSPACE_ROOT=/var/lib/cloudbot-workspaces';

function runScript(args: string[], environment: NodeJS.ProcessEnv = process.env, scriptPath = SCRIPT_PATH): number | null {
    const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: environment });

    return result.status;
}

function pathExists(path: string): Promise<boolean> {
    return lstat(path)
        .then(() => true)
        .catch(() => false);
}

// The helper refuses every argument that is not one plain bot id, before it touches any folder.
describe.skipIf(IS_WINDOWS)('docker/cloudbot-remove-workspace', () => {
    it('refuses a path that leaves the workspace root', () => {
        expect(runScript(['../etc']))
            .toBe(2);
    });

    it('refuses a nested path', () => {
        expect(runScript(['bot/other']))
            .toBe(2);
    });

    it('refuses an id with a space', () => {
        expect(runScript(['bot one']))
            .toBe(2);
    });

    it('refuses an empty id', () => {
        expect(runScript(['']))
            .toBe(2);
    });

    it('refuses a call with no id or more than one argument', () => {
        expect(runScript([]))
            .toBe(2);
        expect(runScript(['bot-1', 'bot-2']))
            .toBe(2);
    });
});

// Runs a copy of the script whose workspace root is a temporary folder, with a temporary home.
describe.skipIf(IS_WINDOWS)('docker/cloudbot-remove-workspace removal', () => {
    const TEMPORARY: string[] = [];

    afterEach(async () => {
        const removals = TEMPORARY.splice(0)
            .map(folder => rm(folder, { recursive: true, force: true }));

        await Promise.all(removals);
    });

    it('removes the workspace and the Claude Code folder of the bot, and keeps the other bot', async () => {
        const sandbox = await mkdtemp(join(tmpdir(), 'cloudbot-helper-'));

        TEMPORARY.push(sandbox);

        const root = join(sandbox, 'workspaces');
        const home = join(sandbox, 'home');
        const scriptCopy = join(sandbox, 'cloudbot-remove-workspace');
        const script = await readFile(SCRIPT_PATH, 'utf8');

        await writeFile(scriptCopy, script.replace(WORKSPACE_ROOT_LINE, `WORKSPACE_ROOT=${root}`));

        const removedWorkspace = join(root, 'bot_1');
        const keptWorkspace = join(root, 'bot-2');
        const removedProject = join(home, '.claude', 'projects', '-var-lib-cloudbot-workspaces-bot-1');
        const keptProject = join(home, '.claude', 'projects', '-var-lib-cloudbot-workspaces-bot-2');
        const folders = [removedWorkspace, keptWorkspace, removedProject, keptProject];

        await Promise.all(folders.map(folder => mkdir(folder, { recursive: true })));

        const status = runScript(['bot_1'], { ...process.env, HOME: home }, scriptCopy);

        expect(status)
            .toBe(0);
        expect(await pathExists(removedWorkspace))
            .toBe(false);
        expect(await pathExists(removedProject))
            .toBe(false);
        expect(await pathExists(keptWorkspace))
            .toBe(true);
        expect(await pathExists(keptProject))
            .toBe(true);
    });
});
