import type { ReviewModel } from './createToolCallReviewer.ts';

// A provider without a sign-in fails every review, and some fail only after a timeout. So a review model that failed
// is skipped for a while and the next one is tried at once.
const DEFAULT_SKIP_MS = 600_000;

function skipAfterFailure(askModel: ReviewModel, skipMs = DEFAULT_SKIP_MS, now = Date.now): ReviewModel {
    const state = { failedAt: undefined as number | undefined };

    return async (prompt, signal, model, effort, onCost) => {
        if (state.failedAt !== undefined && now() - state.failedAt < skipMs) {
            throw new Error('The review model failed a moment ago.');
        }

        try {
            const answer = await askModel(prompt, signal, model, effort, onCost);

            state.failedAt = undefined;

            return answer;
        } catch (error: unknown) {
            if (signal?.aborted !== true) {
                state.failedAt = now();
            }

            throw error;
        }
    };
}

export { skipAfterFailure };
