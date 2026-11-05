import type { ProviderId } from '../providers/providerIds.ts';
import type { ReviewModel } from './createToolCallReviewer.ts';

type ReviewModels = Partial<Record<ProviderId, ReviewModel>>;

// The order for an owner who picked nothing. An owner who connected only ChatGPT or Gemini has no Claude sign-in, so a failed
// review is tried again on the next one.
const REVIEW_ORDER: ProviderId[] = ['claude', 'chatgpt', 'gemini'];

// Asks the provider of the review first and the others after it. Each model name belongs to one provider, so only the provider
// of the review gets the owner's model and effort. With no provider known, every try gets them and each one drops what it cannot use.
function createReviewChain(models: ReviewModels): ReviewModel {
    return (prompt, signal, model, effort, onCost, provider) => {
        const chosen = provider === undefined ? undefined : models[provider];
        const others = REVIEW_ORDER.filter(candidate => candidate !== provider || chosen === undefined)
            .flatMap(candidate => models[candidate] ?? []);
        const [first, ...rest] = chosen === undefined ? others : [chosen, ...others];

        if (first === undefined) {
            return Promise.reject(new Error('No review model is available.'));
        }

        const keepsChoice = provider === undefined;
        const firstTry = keepsChoice || chosen !== undefined ? first(prompt, signal, model, effort, onCost) : first(prompt, signal, undefined, undefined, onCost);

        return rest.reduce((attempt, askNext) => attempt.catch((error: unknown) => {
            if (signal?.aborted === true) {
                throw error;
            }

            return keepsChoice ? askNext(prompt, signal, model, effort) : askNext(prompt, signal);
        }), firstTry);
    };
}

export { createReviewChain };
