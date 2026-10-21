import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';
import type { ChatMessage, ChoiceBody } from '../../shared/chatTypes.ts';

type ToolCallVerdict
    = | { decision: 'allow' }
        // The summary is one line for the owner, for example "Send an email to Ana".
        // The detail, when set, is shown under it as it is written, with its line breaks.
        | { decision: 'ask'; summary: string; detail?: string }
        | { decision: 'deny'; reason: string };

// Decides what happens to one tool call. A throw is treated as ask.
// The signal is the turn's. A review that the turn no longer needs can be stopped with it.
type ToolCallReviewer = (botId: string, call: ToolCall, signal?: AbortSignal) => Promise<ToolCallVerdict>;

// How the gate talks to the chat. close sets the chosen option and returns the stored message.
interface ApprovalChat {
    post: (botId: string, body: ChoiceBody) => Promise<ChatMessage>;
    close: (messageId: string, body: ChoiceBody) => Promise<ChatMessage>;
}

interface ApprovalGateOptions {
    chat: ApprovalChat;
    reviewer: ToolCallReviewer;
    timeoutMs?: number;
    // Called when a call starts and stops waiting for the owner's answer. The turn's time limit does not count that wait.
    onOwnerWait?: (botId: string, isWaiting: boolean) => void;
}

interface PendingApproval {
    botId: string;
    body: ChoiceBody;
    settle: (outcome: ApprovalOutcome) => void;
}

type ApprovalChoiceId = 'approve' | 'deny';

// expired means the turn stopped or nobody answered in time.
type ApprovalOutcome = ApprovalChoiceId | 'expired';

// The agent hook waits at most this long, so it must outlast the default wait below.
const DEFAULT_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_SUMMARY_LENGTH = 300;
const APPROVAL_OPTIONS = [
    { id: 'approve', label: 'Approve' },
    { id: 'deny', label: 'Deny' },
];
const REVIEW_FAILED_SUMMARY = 'Run a tool call that could not be reviewed.';

// A function call keeps TypeScript from narrowing the flag, which can change during an await.
function isStopped(signal: AbortSignal): boolean {
    return signal.aborted;
}

function toOneLine(text: string): string {
    const singleLine = text.replace(/\s+/g, ' ')
        .trim();

    return singleLine.slice(0, MAX_SUMMARY_LENGTH);
}

// The detail keeps its line breaks, so the owner reads a script as it is. It is never cut here: the reviewer refuses a card that is too long.
function buildApprovalBody(summary: string, detail: string | undefined): ChoiceBody {
    const headline = `The bot wants your approval. ${toOneLine(summary)}`;
    const prompt = detail === undefined ? headline : `${headline}\n\n${detail}`;

    return {
        kind: 'choice',
        prompt,
        options: APPROVAL_OPTIONS,
        isApproval: true,
    };
}

function isApprovalChoiceId(choiceId: string): choiceId is ApprovalChoiceId {
    return choiceId === 'approve' || choiceId === 'deny';
}

// Pauses a tool call until the owner answers. Open questions live in memory, so a restart ends them.
class ApprovalGate {
    private readonly chat: ApprovalChat;
    private readonly reviewer: ToolCallReviewer;
    private readonly timeoutMs: number;
    private readonly onOwnerWait: ((botId: string, isWaiting: boolean) => void) | undefined;
    private readonly pendingByMessage = new Map<string, PendingApproval>();

    constructor(options: ApprovalGateOptions) {
        this.chat = options.chat;
        this.reviewer = options.reviewer;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
        this.onOwnerWait = options.onOwnerWait;
    }

    async review(botId: string, call: ToolCall, signal: AbortSignal): Promise<ToolCallDecision> {
        const verdict = await this.readVerdict(botId, call, signal);

        if (verdict.decision === 'allow') {
            return { isAllowed: true };
        }

        if (verdict.decision === 'deny') {
            return { isAllowed: false, reason: verdict.reason };
        }

        return this.askOwner(botId, verdict.summary, signal, verdict.detail);
    }

    isPending(messageId: string): boolean {
        return this.pendingByMessage.has(messageId);
    }

    // Applies the owner's answer. Returns undefined when no question is open for the message.
    async answer(botId: string, messageId: string, choiceId: string): Promise<ChatMessage | undefined> {
        const pending = this.pendingByMessage.get(messageId);

        if (pending?.botId !== botId || !isApprovalChoiceId(choiceId)) {
            return undefined;
        }

        // Removed first, so a second answer to the same question finds nothing.
        this.pendingByMessage.delete(messageId);

        try {
            return await this.chat.close(messageId, { ...pending.body, chosenId: choiceId });
        } finally {
            // The call must not hang when the card cannot be saved. The owner's answer still counts.
            pending.settle(choiceId);
        }
    }

    private async readVerdict(botId: string, call: ToolCall, signal: AbortSignal): Promise<ToolCallVerdict> {
        try {
            return await this.reviewer(botId, call, signal);
        } catch {
            // A reviewer that fails must not let the call through, so the owner decides.
            return { decision: 'ask', summary: REVIEW_FAILED_SUMMARY };
        }
    }

    private async askOwner(botId: string, summary: string, signal: AbortSignal, detail: string | undefined): Promise<ToolCallDecision> {
        if (signal.aborted) {
            return { isAllowed: false, reason: 'The turn was stopped.' };
        }

        const body = buildApprovalBody(summary, detail);
        const posted = await this.chat.post(botId, body);

        // A stop during the post fired its event before the listener existed.
        if (isStopped(signal)) {
            await this.closeQuietly(posted.id, { ...body, chosenId: 'deny' });

            return { isAllowed: false, reason: 'The turn was stopped.' };
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        let expire = (): void => undefined;
        const outcomePromise = new Promise<ApprovalOutcome>((resolve) => {
            // Whoever deletes the entry first wins, so an answer and an expiry never both apply.
            expire = (): void => {
                if (this.pendingByMessage.delete(posted.id)) {
                    resolve('expired');
                }
            };
            this.pendingByMessage.set(posted.id, { botId, body, settle: resolve });
            timer = setTimeout(expire, this.timeoutMs);
            signal.addEventListener('abort', expire, { once: true });
        });

        this.onOwnerWait?.(botId, true);
        const outcome = await outcomePromise.finally(() => {
            this.onOwnerWait?.(botId, false);
        });

        clearTimeout(timer);
        signal.removeEventListener('abort', expire);

        // The owner's answer already closed the question. Stop and timeout close it here.
        if (outcome === 'expired') {
            await this.closeQuietly(posted.id, { ...body, chosenId: 'deny' });
        }

        // An Approve that lands while the turn stops must not let the call run.
        if (outcome === 'approve' && !isStopped(signal)) {
            return { isAllowed: true };
        }

        return { isAllowed: false, reason: 'The owner did not approve this action.' };
    }

    private async closeQuietly(messageId: string, body: ChoiceBody): Promise<void> {
        try {
            await this.chat.close(messageId, body);
        } catch {
            // The call is refused either way. A card that stays open is closed on the next start.
            console.error('Could not close an approval question.');
        }
    }
}

export { ApprovalGate, DEFAULT_APPROVAL_TIMEOUT_MS, buildApprovalBody };
export type { ApprovalChat, ApprovalGateOptions, ToolCallReviewer, ToolCallVerdict };
