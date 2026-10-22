import { isDeepStrictEqual } from 'node:util';

import type { ToolCall, ToolCallDecision } from '../agent/AgentRunner.ts';

// One message from codex app-server: a notification has no id, a server request has both an id and a method.
interface CodexMessage {
    id?: unknown;
    method?: unknown;
    params?: unknown;
}

// What the client sends back for one server request: a result, or a JSON-RPC error.
type CodexAnswer = { result: unknown } | { error: { code: number; message: string } };

type ReviewToolCall = (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;

interface CodexApprovalBridgeOptions {
    threadId: string;
    reviewToolCall: ReviewToolCall;
    // How long one review may take before the call is declined. Tests pass a short one.
    reviewTimeoutMs?: number | undefined;
}

// An item that Codex reported with item/started. File and MCP approvals name only the item, so the details come from here.
type NotedItem
    = | { type: 'fileChange'; turnId: string; changes: unknown[] }
        | { type: 'mcpToolCall'; turnId: string; server: string; tool: string; arguments: unknown };

// The approval gate waits up to one hour for the owner. The bridge waits a little longer, so the gate decides first.
const DEFAULT_REVIEW_TIMEOUT_MS = 65 * 60 * 1000;
const METHOD_NOT_FOUND = -32601;
// The approval kind Codex puts in _meta of an elicitation that asks about an MCP tool call (codex-cli 0.163.0).
const MCP_TOOL_CALL_KIND = 'mcp_tool_call';
// The review sees a command as Bash and an edit as Edit, so the existing rules, the command floor and the review prompt apply.
const COMMAND_TOOL_NAME = 'Bash';
const EDIT_TOOL_NAME = 'Edit';
const DECLINED_COMMAND = { decision: 'decline' };
const DECLINED_ELICITATION = { action: 'decline', content: null, _meta: null };

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    return typeof value === 'string' ? value : undefined;
}

function unknownRequest(method: string): CodexAnswer {
    return { error: { code: METHOD_NOT_FOUND, message: `CloudBot does not answer ${method}.` } };
}

// Resolves with the review, or with a refusal when the review throws, the turn stops or the time runs out.
async function reviewWithin(review: ReviewToolCall, call: ToolCall, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const reviewSignal = AbortSignal.any([signal, timeoutSignal]);

    // A stop that came before this request fired its event already, so the flag is read first.
    if (reviewSignal.aborted) {
        return false;
    }

    const stopped = new Promise<boolean>((resolve) => {
        reviewSignal.addEventListener('abort', () => {
            resolve(false);
        }, { once: true });
    });

    try {
        const reviewed = review(call, reviewSignal)
            .then(decision => decision.isAllowed);

        const isAllowed = await Promise.race([reviewed, stopped]);

        // A review that ignores the signal may still allow after a stop. The stop wins.
        return isAllowed && !reviewSignal.aborted;
    } catch {
        return false;
    }
}

// Answers the approval requests of one Codex thread through CloudBot's review. Every gated request becomes one tool
// call for reviewToolCall, and only its allow becomes an accept. Anything the bridge does not know is declined or
// answered with an error, so Codex never runs a call that was not reviewed.
class CodexApprovalBridge {
    private readonly threadId: string;
    private readonly reviewToolCall: ReviewToolCall;
    private readonly reviewTimeoutMs: number;
    private readonly items = new Map<string, NotedItem>();
    // Items that already got a decision. A second request for the same item is declined.
    private readonly decidedKeys = new Set<string>();

    constructor(options: CodexApprovalBridgeOptions) {
        this.threadId = options.threadId;
        this.reviewToolCall = options.reviewToolCall;
        this.reviewTimeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    }

    // Called for every notification. item/started carries the file changes and the MCP call that a later request names.
    // item/completed forgets the item, so a finished call never makes a later MCP approval ambiguous.
    noteNotification(message: CodexMessage): void {
        if (message.method === 'turn/completed') {
            this.forgetTurn(message.params);

            return;
        }

        if (message.method === 'item/fileChange/patchUpdated') {
            this.notePatchUpdate(message.params);

            return;
        }

        const isStarted = message.method === 'item/started';
        const isCompleted = message.method === 'item/completed';

        if ((!isStarted && !isCompleted) || !isRecord(message.params)) {
            return;
        }

        const params = message.params;
        const item = params.item;
        const turnId = readString(params, 'turnId');

        if (readString(params, 'threadId') !== this.threadId || turnId === undefined || !isRecord(item)) {
            return;
        }

        const itemId = readString(item, 'id');

        if (itemId === undefined) {
            return;
        }

        if (isCompleted) {
            this.items.delete(itemId);

            return;
        }

        if (item.type === 'fileChange' && Array.isArray(item.changes)) {
            this.items.set(itemId, { type: 'fileChange', turnId, changes: item.changes });

            return;
        }

        const server = readString(item, 'server');
        const tool = readString(item, 'tool');

        if (item.type === 'mcpToolCall' && server !== undefined && tool !== undefined) {
            this.items.set(itemId, { type: 'mcpToolCall', turnId, server, tool, arguments: item.arguments });
        }
    }

    // Called for every server request. The answer is what the client sends back under the request's id.
    async answerRequest(message: CodexMessage, signal: AbortSignal): Promise<CodexAnswer> {
        const method = typeof message.method === 'string' ? message.method : 'an unnamed request';
        const params = isRecord(message.params) ? message.params : {};

        switch (method) {
            case 'item/commandExecution/requestApproval':
                return { result: await this.answerCommand(params, signal) };
            case 'item/fileChange/requestApproval':
                return { result: await this.answerFileChange(params, signal) };
            case 'mcpServer/elicitation/request':
                return { result: await this.answerElicitation(params, signal) };
            default:
                // Permission grants, user input, dynamic tools, token refresh, attestation and the old v1 approvals are
                // never used by CloudBot. An error makes Codex treat the request as failed.
                return unknownRequest(method);
        }
    }

    // A shell command. The review sees the whole command line Codex will run, with its folder.
    private async answerCommand(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const command = readString(params, 'command');
        const itemId = readString(params, 'itemId');
        const approvalId = readString(params, 'approvalId') ?? '';
        const isPlainCommand = params.kind === undefined || params.kind === 'command';
        // A network approval asks to widen the sandbox, which CloudBot does not offer.
        const asksForNetwork = params.networkApprovalContext !== undefined && params.networkApprovalContext !== null;

        if (!this.isOwnThread(params) || command === undefined || itemId === undefined || !isPlainCommand || asksForNetwork) {
            return DECLINED_COMMAND;
        }

        if (!this.claimDecision(`${String(params.turnId)}\ncommand\n${itemId}\n${approvalId}`)) {
            return DECLINED_COMMAND;
        }

        const call: ToolCall = { toolName: COMMAND_TOOL_NAME, input: { command, cwd: readString(params, 'cwd') } };
        const isAllowed = await reviewWithin(this.reviewToolCall, call, signal, this.reviewTimeoutMs);

        // Only a plain accept. acceptForSession and policy amendments would let later calls skip the review.
        return isAllowed ? { decision: 'accept' } : DECLINED_COMMAND;
    }

    // A patch can change after item/started. The newest changes replace the noted ones, as a new object, so a review that
    // was already running for the old changes can tell (answerFileChange).
    private notePatchUpdate(params: unknown): void {
        if (!isRecord(params) || readString(params, 'threadId') !== this.threadId || !Array.isArray(params.changes)) {
            return;
        }

        const itemId = readString(params, 'itemId');
        const noted = itemId === undefined ? undefined : this.items.get(itemId);

        if (itemId === undefined || noted?.type !== 'fileChange' || noted.turnId !== params.turnId) {
            return;
        }

        this.items.set(itemId, { type: 'fileChange', turnId: noted.turnId, changes: params.changes });
    }

    // A patch. The request names only the item, so the changes come from its item/started notification.
    private async answerFileChange(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const itemId = readString(params, 'itemId');
        const item = itemId === undefined ? undefined : this.items.get(itemId);
        // grantRoot asks for write access for the rest of the session, which would skip later reviews.
        const asksForRoot = params.grantRoot !== undefined && params.grantRoot !== null;

        if (!this.isOwnThread(params) || item?.type !== 'fileChange' || item.turnId !== params.turnId || asksForRoot) {
            return DECLINED_COMMAND;
        }

        if (!this.claimDecision(`${params.turnId}\nfile\n${itemId ?? ''}`)) {
            return DECLINED_COMMAND;
        }

        const call: ToolCall = { toolName: EDIT_TOOL_NAME, input: { changes: item.changes } };
        const isAllowed = await reviewWithin(this.reviewToolCall, call, signal, this.reviewTimeoutMs);
        // A patch that changed during the review is not the one the review saw.
        const isUnchanged = itemId !== undefined && this.items.get(itemId) === item;

        return isAllowed && isUnchanged ? { decision: 'accept' } : DECLINED_COMMAND;
    }

    // An MCP tool call asks through an elicitation. It names the server, not the item, so exactly one undecided call of
    // that server in the turn must match its arguments. Two at once cannot be told apart, so both are declined.
    private async answerElicitation(params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const meta = isRecord(params._meta) ? params._meta : {};
        const serverName = readString(params, 'serverName');
        const isToolApproval = params.mode === 'form' && meta.codex_approval_kind === MCP_TOOL_CALL_KIND;

        if (!this.isOwnThread(params) || serverName === undefined || !isToolApproval) {
            return DECLINED_ELICITATION;
        }

        const candidates = [...this.items.entries()].filter(([itemId, item]) => item.type === 'mcpToolCall'
            && item.server === serverName
            && item.turnId === params.turnId
            && !this.decidedKeys.has(`${params.turnId}\nmcp\n${itemId}`));
        const match = candidates.length === 1 ? candidates[0] : undefined;

        if (match === undefined || match[1].type !== 'mcpToolCall' || !isDeepStrictEqual(match[1].arguments, meta.tool_params)) {
            return DECLINED_ELICITATION;
        }

        const [itemId, item] = match;

        if (!this.claimDecision(`${String(params.turnId)}\nmcp\n${itemId}`)) {
            return DECLINED_ELICITATION;
        }

        const call: ToolCall = { toolName: `mcp__${item.server}__${item.tool}`, input: item.arguments };
        const isAllowed = await reviewWithin(this.reviewToolCall, call, signal, this.reviewTimeoutMs);

        return isAllowed ? { action: 'accept', content: {}, _meta: null } : DECLINED_ELICITATION;
    }

    // A finished turn needs none of its items or decisions, so a long thread does not keep them.
    private forgetTurn(params: unknown): void {
        const turn = isRecord(params) && isRecord(params.turn) ? params.turn : undefined;
        const turnId = turn === undefined ? undefined : readString(turn, 'id');

        if (!isRecord(params) || readString(params, 'threadId') !== this.threadId || turnId === undefined) {
            return;
        }

        const finishedItemIds = [...this.items.entries()]
            .filter(([, item]) => item.turnId === turnId)
            .map(([itemId]) => itemId);
        const turnPrefix = `${turnId}\n`;
        const finishedKeys = [...this.decidedKeys].filter(key => key.startsWith(turnPrefix));

        finishedItemIds.forEach((itemId) => {
            this.items.delete(itemId);
        });
        finishedKeys.forEach((key) => {
            this.decidedKeys.delete(key);
        });
    }

    // A request must name this thread and a turn. The turn id is part of every decision key.
    private isOwnThread(params: Record<string, unknown>): boolean {
        return readString(params, 'threadId') === this.threadId && readString(params, 'turnId') !== undefined;
    }

    // Read and set with no await between, so two requests for one item cannot both pass.
    private claimDecision(key: string): boolean {
        if (this.decidedKeys.has(key)) {
            return false;
        }

        this.decidedKeys.add(key);

        return true;
    }
}

export { CodexApprovalBridge, DEFAULT_REVIEW_TIMEOUT_MS };
export type { CodexAnswer, CodexApprovalBridgeOptions, CodexMessage };
