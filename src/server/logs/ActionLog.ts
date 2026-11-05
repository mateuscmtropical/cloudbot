import { appendFileSync, renameSync, statSync } from 'node:fs';

import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';

// One action of a bot, for debugging. Only names and outcomes, so the file never holds a tool input, a reply or chat text.
interface ActionLogEntry {
    botId: string;
    event: 'review' | 'tool_finished' | 'turn_error';
    tool?: string | undefined;
    decision?: 'allowed' | 'refused' | 'owner_denied' | 'review_failed' | undefined;
    durationMs?: number | undefined;
    isError?: boolean | undefined;
}

type ToolCallReview = (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

function fileSize(filePath: string): number {
    try {
        return statSync(filePath).size;
    } catch {
        return 0;
    }
}

function decisionName(decision: ToolCallDecision): NonNullable<ActionLogEntry['decision']> {
    if (decision.isAllowed) {
        return 'allowed';
    }

    return decision.isOwnerDenial === true ? 'owner_denied' : 'refused';
}

// A JSON line per action in the data folder, which outlives the container. The file is private to the server user. One old
// file is kept. ponytail: sync writes, fine at one line per tool call. A broken log never stops a bot.
class ActionLog {
    constructor(private readonly filePath: string, private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

    write(entry: ActionLogEntry): void {
        const at = new Date()
            .toISOString();
        const line = JSON.stringify({ at, ...entry });

        try {
            if (fileSize(this.filePath) > this.maxBytes) {
                renameSync(this.filePath, `${this.filePath}.1`);
            }

            appendFileSync(this.filePath, `${line}\n`, { mode: PRIVATE_FILE_MODE });
        } catch (error: unknown) {
            console.error('Could not write the action log:', error);
        }
    }
}

// Notes what the review decided and how long it took, which includes the wait for the owner's card.
function logReviews(review: ToolCallReview, actionLog: ActionLog | undefined, botId: string): ToolCallReview {
    if (actionLog === undefined) {
        return review;
    }

    return async (call, signal) => {
        const startedAt = Date.now();
        const note = (decision: NonNullable<ActionLogEntry['decision']>): void => {
            const durationMs = Date.now() - startedAt;

            actionLog.write({ botId, event: 'review', tool: call.toolName, decision, durationMs });
        };

        try {
            const decision = await review(call, signal);
            const name = decisionName(decision);

            note(name);

            return decision;
        } catch (error: unknown) {
            note('review_failed');

            throw error;
        }
    };
}

export { ActionLog, logReviews };
export type { ActionLogEntry };
