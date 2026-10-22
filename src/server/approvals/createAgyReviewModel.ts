import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

import type { AcpLaunch } from '../agent/AcpEngine.ts';
import { toAgyModel } from '../agent/AgyEngine.ts';
import type { ReviewModel } from './createToolCallReviewer.ts';

interface AgyReviewModelOptions {
    launch: AcpLaunch;
    // The root-owned wrapper and its arguments, see the agy-review action in docker/cloudbot-provider.
    command: string;
    args: string[];
    timeoutMs?: number;
}

interface AgyReviewLine {
    event?: string;
    result?: { status?: string; response?: string };
}

// A review that hangs would hold the bot, so the call gives up and the owner decides.
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
// The owner's review choice is usually a Claude name, which agy does not take. A small model keeps the review quick.
const DEFAULT_AGY_REVIEW_MODEL = 'gemini-3.8-flash-low';

function readResponse(line: string): string | undefined {
    let parsed: AgyReviewLine;

    try {
        parsed = JSON.parse(line) as AgyReviewLine;
    } catch {
        return undefined;
    }

    if (parsed.event !== 'result') {
        return undefined;
    }

    const response = parsed.result?.response ?? '';

    return response.trim() === '' ? '' : response;
}

// Runs one agy turn for each review when Claude is not signed in. The wrapper gives the hook no review address, so
// every tool is refused and the model can only answer in text. A subscription is not billed per call, so no cost is reported.
function createAgyReviewModel(options: AgyReviewModelOptions): ReviewModel {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

    return (prompt, signal, model, effort) => new Promise((resolve, reject) => {
        const agyModel = toAgyModel(model, effort) ?? DEFAULT_AGY_REVIEW_MODEL;
        const child = options.launch.spawnFunction(options.command, options.args, {
            cwd: tmpdir(),
            env: { PATH: process.env.PATH ?? '', CLOUDBOT_AGY_MODEL: agyModel },
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: false,
            windowsHide: true,
            detached: true,
        });
        const state = { answer: undefined as string | undefined };
        const stop = (): void => {
            options.launch.signalProcess(child, 'KILL');
        };
        const timer = setTimeout(stop, timeoutMs);

        signal?.addEventListener('abort', stop, { once: true });
        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);

        if (child.stdout === null) {
            clearTimeout(timer);
            stop();
            reject(new Error('The review model could not start.'));

            return;
        }

        const lines = createInterface({ input: child.stdout });

        lines.on('line', (line) => {
            const response = readResponse(line);

            if (response !== undefined && state.answer === undefined) {
                state.answer = response;
                stop();
            }
        });
        lines.on('close', () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);

            if (state.answer === undefined || state.answer === '') {
                reject(new Error('The review model did not answer.'));

                return;
            }

            resolve(state.answer);
        });

        const message = { event: 'user', message: { content: [{ type: 'text', text: prompt }] } };

        child.stdin?.end(`${JSON.stringify(message)}\n`);
    });
}

export { createAgyReviewModel };
export type { AgyReviewModelOptions };
