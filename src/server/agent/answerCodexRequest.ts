import type { ToolCall, ToolCallDecision } from './AgentRunner.ts';
import { isFileChangeItem } from './codexProtocol.ts';
import type { CodexFileChange, CodexMcpToolCallItem, CodexThreadItem } from './codexProtocol.ts';
import { inputKeyOf } from './createLoopbackToolServer.ts';

interface CodexRequestContext {
    reviewToolCall: (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;
    signal: AbortSignal;
    // The item that a file change approval names. Codex sends the changes in item/started, not in the request.
    findItem: (itemId: string) => CodexThreadItem | undefined;
    // The review gets this long. After it the call is declined, and the review signal fires so a waiting card closes.
    timeoutMs: number;
    // The folder of the turn. A command that runs elsewhere is reviewed with a visible cd first.
    workspaceDir: string;
    // False once the turn has used its steps. A further command or file change is declined without a review.
    hasStepsLeft: () => boolean;
    // The bot's own MCP server, when the turn has tools. Any other server's question is declined.
    toolServer?: CodexToolServer | undefined;
}

interface CodexToolServer {
    name: string;
    // Every tool call item the turn has started, so a question can be matched to the one call it is about.
    toolCalls: () => CodexMcpToolCallItem[];
    // The items already decided. Each gets one decision.
    decidedItemIds: Set<string>;
    // Tools the owner blocked, by full name.
    blockedTools: string[];
    // Lets the loopback server run this one call, once.
    allowCall: (itemId: string, toolName: string, input: unknown) => void;
}

type CodexAnswer = { result: unknown } | { error: { code: number; message: string } };

const METHOD_NOT_SUPPORTED = -32601;
const NOT_SUPPORTED_MESSAGE = 'CloudBot does not answer this request.';
// Codex wraps each command in a login shell, as `/bin/bash -lc 'cat /etc/hostname'`, and leaves the quotes off a
// command of one plain word, as `/bin/bash -lc ls` (seen with codex-cli 0.163.0 in the canary). The command floor and
// the reviewer must see the command itself.
const SHELL_WRAPPER_PATTERN = /^(?:\/usr)?(?:\/bin\/)?(?:bash|sh|zsh) -lc (?:'([^']*)'|([\w./@%+=:,-]+))$/;

const DECLINE_COMMAND: CodexAnswer = { result: { decision: 'decline' } };
const ACCEPT_COMMAND: CodexAnswer = { result: { decision: 'accept' } };
const DECLINE_ELICITATION: CodexAnswer = { result: { action: 'decline', content: null, _meta: null } };
const ACCEPT_ELICITATION: CodexAnswer = { result: { action: 'accept', content: null, _meta: null } };
// The kind Codex puts in the _meta of a tool call question (seen with codex-cli 0.163.0).
const TOOL_CALL_APPROVAL_KIND = 'mcp_tool_call';
const NOT_SUPPORTED: CodexAnswer = { error: { code: METHOD_NOT_SUPPORTED, message: NOT_SUPPORTED_MESSAGE } };

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// A field that is missing or null. Codex leaves the fields of an escalation out of a plain approval.
function isUnset(record: Record<string, unknown>, key: string): boolean {
    const value = record[key];

    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

// Single quotes for the shell, so the folder in the reviewed command reads as one word.
function quoteForShell(text: string): string {
    return `'${text.replaceAll('\'', '\'\\\'\'')}'`;
}

function readText(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    return typeof value === 'string' ? value : undefined;
}

// A wrapped command with a quote inside is kept whole, since the inner text could not be read back exactly.
function unwrapShellCommand(command: string): string {
    const match = SHELL_WRAPPER_PATTERN.exec(command);

    return match?.[1] ?? match?.[2] ?? command;
}

// A review that throws, or does not answer in time, is a refusal. A Codex call is never let through by a failure.
async function reviewInTime(call: ToolCall, context: CodexRequestContext): Promise<boolean> {
    const timeoutController = new AbortController();
    const reviewSignal = AbortSignal.any([context.signal, timeoutController.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
            timeoutController.abort();
            resolve(false);
        }, context.timeoutMs);
    });
    const reviewed = context.reviewToolCall(call, reviewSignal)
        .then(decision => decision.isAllowed)
        .catch(() => false);

    try {
        return await Promise.race([reviewed, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

// Only a plain command is reviewed. A write to the input of a running command (writeStdin) is declined.
// A request with a reason, a network host or a network rule is a retry outside the sandbox or a network grant, which an
// accept would give. The review would see the same command as before, so these are declined. A plain approval has none
// of these fields (checked with codex-cli 0.163.0).
async function answerCommand(params: Record<string, unknown>, context: CodexRequestContext): Promise<CodexAnswer> {
    const command = readText(params, 'command');
    const kind = readText(params, 'kind') ?? 'command';
    const isEscalation = !isUnset(params, 'reason') || !isUnset(params, 'networkApprovalContext') || !isUnset(params, 'proposedNetworkPolicyAmendments');

    if (command === undefined || kind !== 'command' || isEscalation || !context.hasStepsLeft()) {
        return DECLINE_COMMAND;
    }

    const unwrapped = unwrapShellCommand(command);
    const cwd = readText(params, 'cwd') ?? context.workspaceDir;
    // The model picks the folder of each command. The review sees it the way a Claude Bash call would show it.
    const reviewedCommand = cwd === context.workspaceDir ? unwrapped : `cd ${quoteForShell(cwd)} && ${unwrapped}`;
    const isAllowed = await reviewInTime({ toolName: 'Bash', input: { command: reviewedCommand } }, context);

    return isAllowed ? ACCEPT_COMMAND : DECLINE_COMMAND;
}

// Each file of a patch is reviewed as the Write or Edit it is, so the command floor checks its path.
// A moved file is also reviewed as a write to its new path.
function fileChangeCalls(change: CodexFileChange): ToolCall[] {
    if (change.kind.type === 'add') {
        return [{ toolName: 'Write', input: { file_path: change.path, content: change.diff } }];
    }

    const editCall = { toolName: 'Edit', input: { file_path: change.path, diff: change.diff, change: change.kind.type } };
    const movePath = change.kind.type === 'update' ? change.kind.move_path : null;

    return movePath === null ? [editCall] : [editCall, { toolName: 'Write', input: { file_path: movePath, content: change.diff } }];
}

// The calls are reviewed one at a time, and the first refusal declines the whole patch.
async function answerFileChange(params: Record<string, unknown>, context: CodexRequestContext): Promise<CodexAnswer> {
    const itemId = readText(params, 'itemId');
    const item = itemId === undefined ? undefined : context.findItem(itemId);

    // A grant root would allow writes under a folder for the rest of the session, past this one patch.
    if (!isUnset(params, 'grantRoot') || !isUnset(params, 'reason') || !context.hasStepsLeft()) {
        return DECLINE_COMMAND;
    }

    if (item === undefined || !isFileChangeItem(item) || item.changes.length === 0) {
        return DECLINE_COMMAND;
    }

    const calls = item.changes.flatMap(fileChangeCalls);
    const allAllowedSoFar = Promise.resolve(true);
    const isAllowed = await calls.reduce<Promise<boolean>>(
        async (previous, call) => (await previous) && reviewInTime(call, context),
        allAllowedSoFar,
    );

    return isAllowed ? ACCEPT_COMMAND : DECLINE_COMMAND;
}

// A tool call question names the server and the arguments, but not the tool or the call. It is matched to the started
// calls of that server with the same arguments that are not decided yet. Only exactly one match is reviewed. With more
// than one, all of them are declined, since the review could not know which call it would allow.
function findQuestionedCalls(params: Record<string, unknown>, server: CodexToolServer): CodexMcpToolCallItem[] {
    const meta = readRecord(params._meta);
    const isToolQuestion = params.serverName === server.name && params.mode === 'form' && meta.codex_approval_kind === TOOL_CALL_APPROVAL_KIND;

    if (!isToolQuestion) {
        return [];
    }

    const argumentsKey = inputKeyOf(meta.tool_params);

    return server.toolCalls()
        .filter(item => item.server === server.name && item.status === 'inProgress' && !server.decidedItemIds.has(item.id))
        .filter(item => inputKeyOf(item.arguments) === argumentsKey);
}

async function answerToolQuestion(params: Record<string, unknown>, context: CodexRequestContext): Promise<CodexAnswer> {
    const server = context.toolServer;
    const candidates = server === undefined ? [] : findQuestionedCalls(params, server);
    const item = candidates.length === 1 ? candidates[0] : undefined;

    // Marked before the review, so a second question for the same call cannot be answered while the first waits.
    candidates.forEach((candidate) => {
        server?.decidedItemIds.add(candidate.id);
    });

    if (server === undefined || item === undefined) {
        return DECLINE_ELICITATION;
    }

    const toolName = `mcp__${server.name}__${item.tool}`;

    if (server.blockedTools.includes(toolName) || !context.hasStepsLeft()) {
        return DECLINE_ELICITATION;
    }

    const isAllowed = await reviewInTime({ toolName, input: item.arguments }, context);

    if (!isAllowed) {
        return DECLINE_ELICITATION;
    }

    server.allowCall(item.id, toolName, item.arguments);

    return ACCEPT_ELICITATION;
}

// The answer to one request that Codex sends to CloudBot. Anything not known here is declined or refused.
// Codex has no outside MCP servers in this engine yet. Only a tool call question for the bot's own server is reviewed.
function answerCodexRequest(method: string, params: unknown, context: CodexRequestContext): Promise<CodexAnswer> {
    const record = readRecord(params);

    if (method === 'item/commandExecution/requestApproval') {
        return answerCommand(record, context);
    }

    if (method === 'item/fileChange/requestApproval') {
        return answerFileChange(record, context);
    }

    if (method === 'mcpServer/elicitation/request') {
        return answerToolQuestion(record, context);
    }

    // The older approval requests, which a v2 thread does not send. They are refused all the same.
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
        return Promise.resolve({ result: { decision: 'abort' } });
    }

    // The rest, such as a token refresh or a question for the user, has no safe yes. An error makes Codex give up on it.
    return Promise.resolve(NOT_SUPPORTED);
}

export { answerCodexRequest, unwrapShellCommand };
export type { CodexAnswer, CodexRequestContext, CodexToolServer };
