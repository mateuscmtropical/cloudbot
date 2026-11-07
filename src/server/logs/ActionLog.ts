import { appendFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';

import type { ActionDecision, ActionLogEntry, ActionLogRecord } from '../../shared/actionLogTypes.ts';
import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';
import { maskSensitiveNumbers } from '../sensitive/sensitiveNumbers.ts';

// What the approval gate tells the log about one decision. The gate fills it while the review runs.
interface AuditNote {
    decision?: ActionDecision;
    decidedBy?: string;
    summary?: string;
    reason?: string;
}

type ToolCallReview = (call: ToolCall, signal: AbortSignal, note?: AuditNote) => Promise<ToolCallDecision>;

const MAX_TEXT_LENGTH = 200;

// The log keeps one short line. Card and ID numbers are masked, since a card line is written by a model.
function toLogText(text: string | undefined): string | undefined {
    if (text === undefined || text === '') {
        return undefined;
    }

    const oneLine = text.replace(/\s+/g, ' ');
    const masked = maskSensitiveNumbers(oneLine);

    return masked.length > MAX_TEXT_LENGTH ? `${masked.slice(0, MAX_TEXT_LENGTH)}...` : masked;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;
const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function readLines(filePath: string): string[] {
    try {
        const text = readFileSync(filePath, 'utf8');
        const lines = text.split('\n');

        return lines.filter(line => line !== '');
    } catch {
        return [];
    }
}

function parseLine(line: string): ActionLogRecord | undefined {
    try {
        return JSON.parse(line) as ActionLogRecord;
    } catch {
        return undefined;
    }
}

function fileSize(filePath: string): number {
    try {
        return statSync(filePath).size;
    } catch {
        return 0;
    }
}

function decisionName(decision: ToolCallDecision): ActionDecision {
    if (decision.isAllowed) {
        return 'allowed';
    }

    return decision.isOwnerDenial === true ? 'owner_denied' : 'refused';
}

// A JSON line per action in the data folder, which outlives the container. The file is private to the server user. One old
// file is kept, and prune drops what passed the retention. ponytail: sync file work, fine at one line per tool call and
// at most two files of 5 MB. A broken log never stops a bot.
class ActionLog {
    constructor(private readonly filePath: string, private readonly maxBytes: number = DEFAULT_MAX_BYTES, private readonly now: () => number = () => Date.now()) {}

    write(entry: ActionLogEntry): void {
        const nowMs = this.now();
        const time = new Date(nowMs);
        const at = time.toISOString();
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

    // The newest entries first, from both files, without any that passed the retention.
    // A bot, a decision and a start time narrow the list before the limit counts.
    read(limit: number, botId?: string, decision?: string, sinceMs?: number): ActionLogRecord[] {
        const oldLines = readLines(`${this.filePath}.1`);
        const currentLines = readLines(this.filePath);
        const lines = [...oldLines, ...currentLines];
        const parsed = lines.map(parseLine);
        const entries = parsed.filter(entry => entry !== undefined && this.isFresh(entry)
            && (botId === undefined || entry.botId === botId)
            && (decision === undefined || entry.decision === decision)
            && (sinceMs === undefined || Date.parse(entry.at) >= sinceMs)) as ActionLogRecord[];
        const newest = entries.slice(-limit);

        return newest.reverse();
    }

    // Removes what passed the retention from both files.
    prune(): void {
        this.pruneFile(this.filePath);
        this.pruneFile(`${this.filePath}.1`);
    }

    private isFresh(entry: ActionLogRecord): boolean {
        return Date.parse(entry.at) > this.now() - RETENTION_MS;
    }

    private pruneFile(filePath: string): void {
        const lines = readLines(filePath);
        const kept = lines.filter((line) => {
            const entry = parseLine(line);

            return entry !== undefined && this.isFresh(entry);
        });

        if (kept.length === lines.length) {
            return;
        }

        try {
            if (kept.length === 0) {
                rmSync(filePath, { force: true });

                return;
            }

            const nextPath = `${filePath}.next`;
            const text = kept.join('\n');

            writeFileSync(nextPath, `${text}\n`, { mode: PRIVATE_FILE_MODE });
            renameSync(nextPath, filePath);
        } catch (error: unknown) {
            console.error('Could not prune the action log:', error);
        }
    }
}

// Notes what the review decided and how long it took, which includes the wait for the owner's card.
function logReviews(review: ToolCallReview, actionLog: ActionLog | undefined, botId: string, channelId?: string): ToolCallReview {
    if (actionLog === undefined) {
        return review;
    }

    return async (call, signal) => {
        const startedAt = Date.now();
        const auditNote: AuditNote = {};
        const note = (decision: ActionDecision): void => {
            const durationMs = Date.now() - startedAt;

            actionLog.write({
                botId,
                event: 'review',
                tool: call.toolName,
                decision,
                decidedBy: toLogText(auditNote.decidedBy),
                summary: toLogText(auditNote.summary),
                reason: toLogText(auditNote.reason),
                channelId,
                durationMs,
            });
        };

        try {
            const decision = await review(call, signal, auditNote);

            note(auditNote.decision ?? decisionName(decision));

            return decision;
        } catch (error: unknown) {
            note('review_failed');

            throw error;
        }
    };
}

export { ActionLog, RETENTION_DAYS, logReviews };
export type { AuditNote, ToolCallReview };
