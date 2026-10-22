import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { signalProcessTree } from './ClaudeCliEngine.ts';
import type { SignalAction, SpawnFunction } from './ClaudeCliEngine.ts';
import { validateAgentUser } from './createAgentUserSpawn.ts';

// A root-owned script in the image, see docker/cloudbot-codex. It runs only `codex app-server` and sets CODEX_HOME in the
// agent user's home, so the server never makes or reads the folder that holds the ChatGPT sign-in.
const CODEX_AGENT_WRAPPER = '/usr/local/bin/cloudbot-codex';
const AGENT_PATH = '/usr/local/bin:/usr/bin:/bin';
// The wrapper and sudo set these, so the server never passes them.
const DROPPED_VARIABLES = new Set(['HOME', 'PATH', 'CODEX_HOME']);

interface CodexAgentLaunch {
    spawnFunction: SpawnFunction;
    signalProcess: (child: ChildProcess, action: SignalAction) => void;
}

// Starts Codex as the agent user through sudo, like the Claude CLI. sudo keeps only the names in its env_keep.
function codexAgentLaunch(agentUser: string, spawnFunction: SpawnFunction = spawn): CodexAgentLaunch {
    validateAgentUser(agentUser);

    return {
        spawnFunction: (_command, args, options) => {
            const passedEntries = Object.entries(options.env ?? {});
            const keptEntries = passedEntries.filter(([name, value]) => !DROPPED_VARIABLES.has(name) && typeof value === 'string');
            const keptVariables = Object.fromEntries(keptEntries) as Record<string, string>;
            const environment = { ...keptVariables, HOME: `/home/${agentUser}`, PATH: AGENT_PATH };

            return spawnFunction('/usr/bin/sudo', ['-n', '-u', agentUser, '--', CODEX_AGENT_WRAPPER, ...args], { ...options, env: environment });
        },
        signalProcess: (child, action) => {
            signalProcessTree(child, action, agentUser);
        },
    };
}

export { CODEX_AGENT_WRAPPER, codexAgentLaunch };
export type { CodexAgentLaunch };
