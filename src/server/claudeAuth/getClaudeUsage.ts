import { execFile } from 'node:child_process';

import { buildClaudeCommand } from '../agent/buildClaudeCommand.ts';
import type { ClaudeAuthStatusOptions } from './getClaudeAuthStatus.ts';

// `claude -p "/usage"` is a local command. It reads the plan usage and sends no prompt to a model.
// The CLI loads its plugins first, so this takes several seconds.
const USAGE_TIMEOUT_MS = 30_000;
const USAGE_MAX_BUFFER = 262_144;

function runUsageCommand(command: string, commandArguments: string[], environment?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, commandArguments, { env: environment, encoding: 'utf8', timeout: USAGE_TIMEOUT_MS, maxBuffer: USAGE_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
            if (error) {
                reject(new Error('Could not read the Claude usage.'));

                return;
            }

            resolve(stdout);
        });
    });
}

// The text of the CLI's own `/usage` screen. It is empty when the CLI gives no usage, such as with an API key.
async function getClaudeUsageText(options: ClaudeAuthStatusOptions): Promise<string> {
    const invocation = buildClaudeCommand(options.claudePath, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], options.agentUser, options.configDir);
    const runCommand = options.runCommand ?? runUsageCommand;
    const output = await runCommand(invocation.command, invocation.args, invocation.env);
    const answer: unknown = JSON.parse(output);

    if (answer === null || typeof answer !== 'object' || !('result' in answer) || typeof answer.result !== 'string') {
        return '';
    }

    return answer.result;
}

export { getClaudeUsageText };
