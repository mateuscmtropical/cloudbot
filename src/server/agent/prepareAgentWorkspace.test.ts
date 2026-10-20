import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorkspacePath, prepareAgentWorkspace } from './prepareAgentWorkspace.ts';

const TEMPORARY_DIRECTORIES: string[] = [];

afterEach(async () => {
    const removals = TEMPORARY_DIRECTORIES.splice(0)
        .map(directory => rm(directory, { recursive: true, force: true }));

    await Promise.all(removals);
});

async function workspaceRoot(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'cloudbot-workspaces-'));

    TEMPORARY_DIRECTORIES.push(directory);

    return directory;
}

describe('prepareAgentWorkspace', () => {
    it.skipIf(process.platform === 'win32')('restores group write after a restrictive umask and on reuse', async () => {
        const root = await workspaceRoot();
        const oldUmask = process.umask(0o077);

        try {
            const workspace = await prepareAgentWorkspace(agentWorkspacePath('bot-1', root));
            const created = await stat(workspace);

            expect(created.mode & 0o777)
                .toBe(0o770);
            await chmod(workspace, 0o700);
            await prepareAgentWorkspace(agentWorkspacePath('bot-1', root));
            const reused = await stat(workspace);

            expect(reused.mode & 0o777)
                .toBe(0o770);
        } finally {
            process.umask(oldUmask);
        }
    });

    // The workspace code runs only in the Linux image. Windows has no O_NOFOLLOW or fchmod on folders.
    it.skipIf(process.platform === 'win32')('creates a workspace under the prepared root and reuses it', async () => {
        const root = await workspaceRoot();
        const workspace = await prepareAgentWorkspace(agentWorkspacePath('bot-1', root));

        expect(workspace)
            .toBe(`${root}/bot-1`);
        await expect(prepareAgentWorkspace(agentWorkspacePath('bot-1', root))).resolves.toBe(workspace);
    });

    it('rejects ids that escape the workspace root', () => {
        ['../vault', '.', '', '/absolute', 'nested/bot', 'nested\\bot'].forEach((botId) => {
            expect(() => agentWorkspacePath(botId, '/workspaces'))
                .toThrow('Invalid bot id');
        });
    });

    it.skipIf(process.platform === 'win32')('rejects an existing file as a workspace', async () => {
        const root = await workspaceRoot();
        const workspace = agentWorkspacePath('bot-1', root);

        await writeFile(workspace, 'file');
        await expect(prepareAgentWorkspace(agentWorkspacePath('bot-1', root))).rejects.toThrow();
    });

    it.skipIf(process.platform === 'win32')('refuses a symlink and leaves its target mode alone', async () => {
        const root = await workspaceRoot();
        const privateFolder = join(root, 'private');
        const workspace = agentWorkspacePath('bot-1', root);

        await mkdir(privateFolder, { mode: 0o700 });
        await chmod(privateFolder, 0o700);
        await symlink(privateFolder, workspace);
        await expect(prepareAgentWorkspace(agentWorkspacePath('bot-1', root))).rejects.toThrow();
        const privateStat = await stat(privateFolder);

        expect(privateStat.mode & 0o777)
            .toBe(0o700);
    });

    it('reports a missing prepared root', async () => {
        const root = await workspaceRoot();

        await expect(prepareAgentWorkspace(agentWorkspacePath('bot-1', `${root}/missing`))).rejects.toThrow();
    });
});
