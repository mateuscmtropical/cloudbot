import { spawn } from 'node:child_process';
import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

interface AgentUserSpawnOptions {
    user: string;
    executable: string;
    environment?: Record<string, string> | undefined;
    onStderrTail?: ((tail: string) => void) | undefined;
    spawnFunction?: (command: string, args: string[], options: AgentSpawnProcessOptions) => AgentSpawnedProcess;
}

interface AgentSpawnedProcess extends SpawnedProcess {
    stderr: Readable;
}

interface AgentSpawnProcessOptions extends NodeSpawnOptions {
    stdio: ['pipe', 'pipe', 'pipe'];
    shell: false;
}

const AGENT_PATH = '/usr/local/bin:/usr/bin:/bin';
const DUMMY_API_KEY = 'cloudbot-key-proxy';

function spawnAgentProcess(command: string, args: string[], options: AgentSpawnProcessOptions): AgentSpawnedProcess {
    return spawn(command, args, options);
}

function validateAgentUser(user: string): void {
    if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
        throw new Error('Invalid agent user.');
    }
}

function buildAgentEnvironment(user: string, environment?: Record<string, string>): Record<string, string> {
    const proxyUrl = environment?.ANTHROPIC_BASE_URL;
    const proxyEnvironment = proxyUrl
        ? { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: DUMMY_API_KEY }
        : {};

    return { HOME: `/home/${user}`, PATH: AGENT_PATH, ...proxyEnvironment };
}

function createAgentUserSpawn(options: AgentUserSpawnOptions): NonNullable<Options['spawnClaudeCodeProcess']> {
    const spawnFunction = options.spawnFunction ?? spawnAgentProcess;
    const environment = buildAgentEnvironment(options.user, options.environment);

    validateAgentUser(options.user);
    if (!options.executable.startsWith('/')) {
        throw new Error('The agent CLI path must be absolute.');
    }

    return (sdkOptions: SpawnOptions): SpawnedProcess => {
        // Only the configured native CLI is allowed by sudoers.
        if (sdkOptions.command !== options.executable) {
            throw new Error('The SDK requested an unexpected agent executable.');
        }

        const args = ['-n', '-u', options.user, '--', options.executable, ...sdkOptions.args];
        const spawnOptions: AgentSpawnProcessOptions = {
            cwd: sdkOptions.cwd,
            env: environment,
            signal: sdkOptions.signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
        };

        const child = spawnFunction('/usr/bin/sudo', args, spawnOptions);
        let stderrTail = Buffer.alloc(0);

        child.stderr.on('data', (chunk: Buffer) => {
            const combined = Buffer.concat([stderrTail, chunk]);

            stderrTail = combined.subarray(-4096);
            // Copy the tail so a small view cannot retain a large chunk.
            stderrTail = Buffer.from(stderrTail);
            const tailText = stderrTail.toString('utf8');

            options.onStderrTail?.(tailText);
        });

        return child;
    };
}

export { buildAgentEnvironment, createAgentUserSpawn, validateAgentUser };
export type { AgentUserSpawnOptions };
