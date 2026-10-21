import { execFile } from 'node:child_process';

// The fixed script in the image. sudoers lets the server user run it as the agent user, and no other command.
const SUDO_PATH = '/usr/bin/sudo';
const REMOVE_WORKSPACE_PATH = '/usr/local/bin/cloudbot-remove-workspace';
const BOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

type RunCommand = (file: string, args: string[]) => Promise<void>;

function runCommand(file: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(file, args, (error) => {
            if (error) {
                reject(new Error('The bot workspace could not be removed.'));

                return;
            }

            resolve();
        });
    });
}

// The agent user owns the workspace files, so the agent user removes them, through the fixed script.
async function removeAgentWorkspace(agentUser: string, botId: string, run: RunCommand = runCommand): Promise<void> {
    if (!BOT_ID_PATTERN.test(botId)) {
        throw new Error('Invalid bot id for a folder.');
    }

    await run(SUDO_PATH, ['-n', '-u', agentUser, '--', REMOVE_WORKSPACE_PATH, botId]);
}

export { removeAgentWorkspace };
export type { RunCommand };
