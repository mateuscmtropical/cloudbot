import { execFile } from 'node:child_process';

interface ClaudeAuthStatus {
    isLoggedIn: boolean;
    method?: string;
}

type RunClaudeCommand = (command: string, commandArguments: string[]) => Promise<string>;

interface ClaudeAuthStatusOptions {
    claudePath: string;
    runCommand?: RunClaudeCommand;
}

function runClaudeCommand(command: string, commandArguments: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, commandArguments, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
            // The CLI may return 1 with JSON when it is signed out.
            if (error && error.code !== 1) {
                const message = error.code === 'ENOENT' ? 'Claude CLI is missing.' : 'Could not check Claude sign-in status.';

                reject(new Error(message));

                return;
            }

            resolve(stdout);
        });
    });
}

async function getClaudeAuthStatus(options: ClaudeAuthStatusOptions): Promise<ClaudeAuthStatus> {
    const runCommand = options.runCommand ?? runClaudeCommand;
    let output: string;

    try {
        output = await runCommand(options.claudePath, ['auth', 'status', '--json']);
    } catch {
        throw new Error('Could not check Claude sign-in status. Verify that the Claude CLI is installed and try again.');
    }

    let status: unknown;

    try {
        status = JSON.parse(output);
    } catch {
        throw new Error('Claude CLI returned invalid sign-in status JSON.');
    }

    if (typeof status !== 'object' || status === null || !('loggedIn' in status) || typeof status.loggedIn !== 'boolean') {
        throw new Error('Claude CLI returned an invalid sign-in status.');
    }

    const result: ClaudeAuthStatus = { isLoggedIn: status.loggedIn };

    if ('authMethod' in status && typeof status.authMethod === 'string') {
        result.method = status.authMethod;
    }

    return result;
}

export { getClaudeAuthStatus };
export type { ClaudeAuthStatus, ClaudeAuthStatusOptions, RunClaudeCommand };
