import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { isClaudeModel } from '../models/modelChoices.ts';
import type { EffortLevel } from '../models/modelChoices.ts';
import type { ReviewModel } from './createToolCallReviewer.ts';

type ReviewSpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

interface ClaudeReviewModelOptions {
    pathToClaudeCodeExecutable?: string | undefined;
    // Read on every call, because the sign-in mode can change while the server runs.
    environment?: Record<string, string>;
    // Any folder. The review reads no files.
    workingDirectory: string;
    // Tests inject a fake here. Production leaves it out and starts the claude CLI.
    spawnFunction?: ReviewSpawnFunction;
    timeoutMs?: number;
}

// The last line of the CLI's JSON output. It is the result of the one turn.
interface ReviewResultLine {
    type: string;
    subtype?: string | undefined;
    is_error?: boolean | undefined;
    result?: string | undefined;
    total_cost_usd?: number | undefined;
}

// A review that hangs would hold the bot, so the call gives up and the owner decides.
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_SYSTEM_PROMPT = 'You are a careful reviewer of tool calls. You answer with one JSON object and nothing else.';

function buildReviewArguments(model: string | undefined, effort: EffortLevel | undefined): string[] {
    const modelArguments = model === undefined || !isClaudeModel(model) ? [] : ['--model', model];
    const effortArguments = effort === undefined ? [] : ['--effort', effort];

    // No tools, no settings files and no saved session: the model can only answer in text, in one turn.
    return [
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--tools',
        '',
        '--setting-sources',
        '',
        '--system-prompt',
        REVIEW_SYSTEM_PROMPT,
        ...modelArguments,
        ...effortArguments,
    ];
}

function readAnswer(stdout: string): ReviewResultLine {
    const lines = stdout.trim()
        .split('\n');
    const lastLine = lines.at(-1) ?? '';

    try {
        const parsed = JSON.parse(lastLine) as ReviewResultLine;

        return parsed;
    } catch {
        throw new Error('The review model sent no answer.');
    }
}

// Runs the CLI once with the prompt on stdin. The call is stopped by the signal or by the timeout.
function runReviewProcess(
    options: ClaudeReviewModelOptions,
    args: string[],
    prompt: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
): Promise<string> {
    const spawnFunction = options.spawnFunction ?? spawn;
    const command = options.pathToClaudeCodeExecutable ?? 'claude';
    const spawnOptions: SpawnOptions = {
        cwd: options.workingDirectory,
        env: options.environment,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
    };

    return new Promise((resolve, reject) => {
        const child = spawnFunction(command, args, spawnOptions);
        let stdout = '';

        const stop = (): void => {
            child.kill();
        };
        const timer = setTimeout(stop, timeoutMs);

        const finish = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
        };

        signal?.addEventListener('abort', stop, { once: true });
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.on('error', () => {
            finish();
            reject(new Error('The review model could not start.'));
        });
        child.on('close', () => {
            finish();
            resolve(stdout);
        });
        child.stdin?.on('error', () => {
            // The CLI may exit before it reads the prompt. The exit code and the output decide the result.
        });
        child.stdin?.end(prompt);
    });
}

// Runs one claude CLI call with no tools for each review.
function createClaudeReviewModel(options: ClaudeReviewModelOptions): ReviewModel {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

    return async (prompt, signal, model, effort, onCost) => {
        const args = buildReviewArguments(model, effort);
        const stdout = await runReviewProcess(options, args, prompt, signal, timeoutMs);
        const result = readAnswer(stdout);

        if (result.type !== 'result') {
            throw new Error('The review model sent no answer.');
        }

        if (result.subtype !== 'success' || result.is_error === true || result.result === undefined) {
            throw new Error('The review model did not answer.');
        }

        // The review has no subagents, so its result carries the whole cost of this review.
        onCost?.(result.total_cost_usd ?? 0);

        return result.result;
    };
}

export { createClaudeReviewModel };
export type { ClaudeReviewModelOptions, ReviewSpawnFunction };
