// The reply being streamed. It lives outside React state, so a new delta redraws the draft bubble and nothing else.
interface DraftState {
    botId: string;
    text: string;
    // The highest message sequence known when the draft started. Older replies never clear it.
    afterSequence: number;
}

interface DraftStore {
    get: () => DraftState;
    set: (next: DraftState) => void;
    subscribe: (listener: () => void) => () => void;
}

const EMPTY_DRAFT: DraftState = { botId: '', text: '', afterSequence: 0 };

function createDraftStore(initial: DraftState = EMPTY_DRAFT): DraftStore {
    const listeners = new Set<() => void>();
    let draft = initial;

    return {
        get: () => draft,
        set: (next) => {
            if (next === draft) {
                return;
            }

            draft = next;
            listeners.forEach((listener) => {
                listener();
            });
        },
        subscribe: (listener) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export { EMPTY_DRAFT, createDraftStore };
export type { DraftState, DraftStore };
