import { buildClaudeCommand } from '../agent/buildClaudeCommand.ts';
import { getClaudeAuthStatus, runClaudeCommand } from './getClaudeAuthStatus.ts';
import type { RunClaudeCommand } from './getClaudeAuthStatus.ts';

interface ClaudeSignOutOptions {
    claudePath: string;
    agentUser?: string;
    configDir?: string;
    platform?: NodeJS.Platform;
    runCommand?: RunClaudeCommand;
}

const SIGN_OUT_FAILED = 'Could not sign out of Claude. Try again.';

// Runs the CLI's own logout. The output is never read or logged, because it may contain account details.
// Logout can exit 1 without signing out, so the sign-in status is checked afterwards.
async function signOutClaude(options: ClaudeSignOutOptions): Promise<void> {
    const runCommand = options.runCommand ?? runClaudeCommand;
    const platform = options.platform ?? process.platform;
    const isLocal = !options.agentUser;

    // Without a folder of its own, the logout would reach the owner's own Claude Code login.
    if (isLocal && options.configDir === undefined) {
        throw new Error('Sign out needs CloudBot\'s own Claude config folder.');
    }

    // On macOS the login lives in the Keychain, which CLAUDE_CONFIG_DIR does not isolate (not verified there).
    if (isLocal && platform === 'darwin') {
        throw new Error('Sign out is not supported in local mode on macOS.');
    }

    const invocation = buildClaudeCommand(options.claudePath, ['auth', 'logout'], options.agentUser, options.configDir);

    try {
        await runCommand(invocation.command, invocation.args, invocation.env);

        const status = await getClaudeAuthStatus({ ...options, runCommand });

        if (status.isLoggedIn) {
            throw new Error(SIGN_OUT_FAILED);
        }
    } catch {
        throw new Error(SIGN_OUT_FAILED);
    }
}

export { signOutClaude };
export type { ClaudeSignOutOptions };
