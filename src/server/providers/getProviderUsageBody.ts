import { spawn } from 'node:child_process';

import type { SpawnFunction } from '../agent/ClaudeCliEngine.ts';
import { PROVIDER_AGENT_WRAPPER, wrapperAgentLaunch } from '../agent/codexAgentLaunch.ts';
import { childPath } from '../childEnvironment.ts';

// The providers whose own CLI calls a usage endpoint with its saved sign-in, see docker/provider-usage.js. Gemini runs
// agy's own `/usage` command, which prints JSON.
type UsageBodyProvider = 'copilot' | 'gemini' | 'kimi';

interface ProviderUsageBodyOptions {
    // Runs the wrapper as this user, who holds the sign-in. The server never reads that sign-in.
    agentUser: string;
    // Tests inject a fake here. Production spawns the wrapper.
    spawnFunction?: SpawnFunction | undefined;
    timeoutMs?: number | undefined;
}

const BODY_TIMEOUT_MS = 20_000;
const BODY_MAX_LENGTH = 262_144;

// Runs `cloudbot-provider <provider> usage` as the agent user and returns the JSON body the CLI's own call got. It fails
// when the sign-in is missing or stale, the call fails or the answer is not JSON. The caller shows "not available".
function getProviderUsageBody(provider: UsageBodyProvider, options: ProviderUsageBodyOptions): Promise<unknown> {
    const launch = wrapperAgentLaunch(options.agentUser, PROVIDER_AGENT_WRAPPER, options.spawnFunction ?? spawn);
    const child = launch.spawnFunction(PROVIDER_AGENT_WRAPPER, [provider, 'usage'], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: childPath() } });

    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
            launch.signalProcess(child, 'KILL');
            reject(new Error('The usage call took too long.'));
        }, options.timeoutMs ?? BODY_TIMEOUT_MS);

        child.stdout?.on('data', (chunk: Buffer) => {
            output = output.length < BODY_MAX_LENGTH ? `${output}${chunk.toString('utf8')}` : output;
        });
        child.once('error', () => {
            clearTimeout(timer);
            reject(new Error('The usage call could not start.'));
        });
        child.once('close', (code) => {
            clearTimeout(timer);

            try {
                if (code !== 0) {
                    throw new Error('The usage call failed.');
                }

                const body: unknown = JSON.parse(output);

                resolve(body);
            } catch {
                reject(new Error('The usage call gave no usage.'));
            }
        });
    });
}

export { getProviderUsageBody };
export type { UsageBodyProvider };
