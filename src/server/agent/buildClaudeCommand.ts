import { join, resolve } from 'node:path';

import { buildAgentEnvironment, validateAgentUser } from './createAgentUserSpawn.ts';

interface ClaudeCommand {
    command: string;
    args: string[];
    env?: Record<string, string>;
}

function validateAgentIsolation(agentUser: string | undefined, nodeEnv = process.env.NODE_ENV): void {
    if (nodeEnv === 'production' && !agentUser) {
        throw new Error('CLOUDBOT_AGENT_USER must be set in production to isolate the agent from the server user.');
    }

    if (agentUser) {
        validateAgentUser(agentUser);
    }
}

// Local mode gives the CLI its own config folder, so CloudBot's login never replaces the owner's Claude Code login.
// The path is absolute, because turns and the review model run with different working directories.
function localClaudeConfigDir(dataDir: string): string {
    const absoluteDataDir = resolve(dataDir);

    return join(absoluteDataDir, 'claude-config');
}

// The owner's own API key and OAuth token are dropped, so they never reach CloudBot's CLI.
function filterOwnerEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
    const inherited = Object.entries(environment)
        .filter((entry): entry is [string, string] => entry[1] !== undefined
            && !entry[0].startsWith('ANTHROPIC_') && entry[0] !== 'CLAUDE_CODE_OAUTH_TOKEN');

    return Object.fromEntries(inherited);
}

function localEnvironment(configDir: string): Record<string, string> {
    const inheritedEnvironment = filterOwnerEnvironment(process.env);

    return { ...inheritedEnvironment, CLAUDE_CONFIG_DIR: configDir };
}

function buildClaudeCommand(claudePath: string, args: string[], agentUser = process.env.CLOUDBOT_AGENT_USER, configDir?: string): ClaudeCommand {
    if (!agentUser) {
        if (configDir === undefined) {
            return { command: claudePath, args };
        }

        return { command: claudePath, args, env: localEnvironment(configDir) };
    }

    validateAgentUser(agentUser);
    if (!claudePath.startsWith('/')) {
        throw new Error('The agent CLI path must be absolute.');
    }

    const env = buildAgentEnvironment(agentUser);

    return { command: '/usr/bin/sudo', args: ['-n', '-u', agentUser, '--', claudePath, ...args], env };
}

export { buildClaudeCommand, filterOwnerEnvironment, localClaudeConfigDir, localEnvironment, validateAgentIsolation };
