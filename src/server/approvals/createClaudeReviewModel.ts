import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ReviewModel } from './createToolCallReviewer.ts';

type ReviewQueryFunction = (parameters: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

interface ClaudeReviewModelOptions {
    pathToClaudeCodeExecutable?: string | undefined;
    // Read on every call, because the sign-in mode can change while the server runs.
    environment?: Record<string, string>;
    // Any folder. The review reads no files.
    workingDirectory: string;
    // Tests inject a fake here. Production leaves it out and uses the SDK query.
    queryFunction?: ReviewQueryFunction;
    timeoutMs?: number;
}

// A review that hangs would hold the bot, so the call gives up and the owner decides.
const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
const REVIEW_SYSTEM_PROMPT = 'You are a careful reviewer of tool calls. You answer with one JSON object and nothing else.';

function buildReviewOptions(options: ClaudeReviewModelOptions, abortController: AbortController, model: string | undefined): Options {
    const executableOption = options.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
        : {};
    const environmentOption = options.environment ? { env: options.environment } : {};
    const modelOption = model === undefined ? {} : { model };

    return {
        cwd: options.workingDirectory,
        abortController,
        // No tools, no settings files and no saved session: the model can only answer in text.
        tools: [],
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        ...executableOption,
        ...environmentOption,
        ...modelOption,
    };
}

function readAnswer(message: SDKMessage): string | undefined {
    if (message.type !== 'result') {
        return undefined;
    }

    if (message.subtype !== 'success' || message.is_error) {
        throw new Error('The review model did not answer.');
    }

    return message.result;
}

// Runs one Claude Agent SDK call with no tools for each review.
function createClaudeReviewModel(options: ClaudeReviewModelOptions): ReviewModel {
    const queryFunction = options.queryFunction ?? query;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;

    return async (prompt, signal, model) => {
        const abortController = new AbortController();
        const abort = (): void => {
            abortController.abort();
        };
        const timer = setTimeout(abort, timeoutMs);

        signal?.addEventListener('abort', abort, { once: true });

        try {
            const queryOptions = buildReviewOptions(options, abortController, model);
            const conversation = queryFunction({ prompt, options: queryOptions });
            let answer: string | undefined;

            // The SDK's Query is an async iterator, so `for await` is the only loop form that fits.
            for await (const message of conversation) {
                answer ??= readAnswer(message);
            }

            if (answer === undefined) {
                throw new Error('The review model sent no answer.');
            }

            return answer;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    };
}

export { createClaudeReviewModel };
export type { ClaudeReviewModelOptions, ReviewQueryFunction };
