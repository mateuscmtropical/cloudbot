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

function buildClaudeCommand(claudePath: string, args: string[], agentUser = process.env.CLOUDBOT_AGENT_USER): ClaudeCommand {
    if (!agentUser) {
        return { command: claudePath, args };
    }

    validateAgentUser(agentUser);
    if (!claudePath.startsWith('/')) {
        throw new Error('The agent CLI path must be absolute.');
    }

    const env = buildAgentEnvironment(agentUser);

    return { command: '/usr/bin/sudo', args: ['-n', '-u', agentUser, '--', claudePath, ...args], env };
}

export { buildClaudeCommand, validateAgentIsolation };
