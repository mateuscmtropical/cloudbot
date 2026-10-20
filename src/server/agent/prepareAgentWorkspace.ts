import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { posix } from 'node:path';

// Where the agent user's workspaces live. The image creates this folder for the agent user.
const AGENT_WORKSPACE_ROOT = '/var/lib/cloudbot-workspaces';

// O_NOFOLLOW makes the open fail on a symlink, so bot cannot swap the folder
// for a link to a server path between the check and the chmod.
const OPEN_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

function agentWorkspacePath(botId: string, root: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) {
        throw new Error('Invalid bot id for an agent workspace.');
    }

    return posix.join(root, botId);
}

// Takes the full workspace path from agentWorkspacePath, so the caller and the runner use one path.
async function prepareAgentWorkspace(workspace: string): Promise<string> {
    // The image prepares the parent with a shared group and setgid.
    try {
        await mkdir(workspace, { mode: 0o770 });
    } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
            throw error;
        }
    }

    const workspaceHandle = await open(workspace, OPEN_DIRECTORY_FLAGS);

    try {
        const workspaceStat = await workspaceHandle.stat();

        if (!workspaceStat.isDirectory()) {
            throw new Error('The agent workspace must be a directory, not a link or file.');
        }

        // chmod on the open handle changes the folder that was checked, not whatever the path points to now.
        await workspaceHandle.chmod(0o770);
    } finally {
        await workspaceHandle.close();
    }

    return workspace;
}

export { AGENT_WORKSPACE_ROOT, agentWorkspacePath, prepareAgentWorkspace };
