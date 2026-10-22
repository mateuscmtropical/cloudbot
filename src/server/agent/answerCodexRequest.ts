import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
    // The Codex config and sign-in folder of the bot. A write here could run programs without a review next turn.
    codexHome: string;
    // False once the turn has used its steps. A further command or file change is declined without a review.
    hasStepsLeft: () => boolean;
    // The bot's own MCP server, when the turn has tools.
    toolServer?: CodexToolServer | undefined;
    // The owner's connected servers of the turn. A question from any server not named here is declined.
    remoteServers?: CodexToolServer[] | undefined;
}

interface CodexToolServer {
    name: string;
    // Every tool call item the turn has started, so a question can be matched to the one call it is about.
    toolCalls: () => CodexMcpToolCallItem[];
    // The items already decided. Each gets one decision.
    decidedItemIds: Set<string>;
    // Tools the owner blocked, by full name.
    blockedTools: string[];
    // Lets the server run this one call, once. A connected server runs the call Codex sends it, so it has nothing to do.
    allowCall: (itemId: string, toolName: string, input: unknown) => void;
}

type CodexAnswer = { result: unknown } | { error: { code: number; message: string } };

const METHOD_NOT_SUPPORTED = -32601;
const NOT_SUPPORTED_MESSAGE = 'CloudBot does not answer this request.';
// Codex wraps each command in a login shell, as `/bin/bash -lc 'cat /etc/hostname'`, and leaves the quotes off a
// command of one plain word, as `/bin/bash -lc ls` (seen with codex-cli 0.163.0 in the canary). The command floor and
// the reviewer must see the command itself.
const SHELL_WRAPPER_PATTERN = /^(?:\/usr)?(?:\/bin\/)?(?:bash|sh|zsh) -lc (?:'([^']*)'|([\w./@%+=:,-]+))$/;
// Any folder named .codex, with either separator and with quotes or spaces around it, so a project config path is
// found in a command.
const CODEX_FOLDER_PATTERN = /(?:^|[\s\\/'"])\.codex(?:[\s\\/'"]|$)/i;

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

function isOutsideFolder(relativePath: string): boolean {
    return relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function isInsideFolder(folder: string, target: string): boolean {
    const relativePath = relative(folder, target);

    return relativePath === '' || !isOutsideFolder(relativePath);
}

function isInsideCodexFolder(workspaceDir: string, target: string): boolean {
    const relativePath = relative(workspaceDir, target);

    if (relativePath === '' || isOutsideFolder(relativePath)) {
        return false;
    }

    const segments = relativePath.split(sep);

    return segments.some(segment => segment.toLowerCase() === '.codex');
}

// A missing file or folder is expected, since a patch creates them. Any other failure is not.
function isMissingPath(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// A patch creates files that do not exist yet, so the nearest ancestor that exists is found first. A symlink in the
// workspace is resolved, since its target is the path that is really written.
function nearestExistingAncestor(target: string): string | undefined {
    try {
        lstatSync(target);

        return target;
    } catch (error) {
        if (!isMissingPath(error)) {
            throw error;
        }
    }

    const parent = dirname(target);

    return parent === target ? undefined : nearestExistingAncestor(parent);
}

function realPathOfChange(target: string): string | undefined {
    try {
        const ancestor = nearestExistingAncestor(target);

        if (ancestor === undefined) {
            return undefined;
        }

        const realAncestor = realpathSync(ancestor);
        const tail = relative(ancestor, target);

        return tail === '' ? realAncestor : join(realAncestor, tail);
    } catch {
        return undefined;
    }
}

function realPathOrUndefined(target: string): string | undefined {
    try {
        return realpathSync(target);
    } catch {
        return undefined;
    }
}

// The path of a change can be relative to the workspace. It is resolved before it is checked, so `..` cannot hide
// the Codex home or a project .codex folder.
// A path of a change that cannot be resolved is forbidden. A refused patch is better than a missed symlink.
function isForbiddenPath(targetPath: string, context: CodexRequestContext): boolean {
    const resolvedWorkspace = resolve(context.workspaceDir);
    const resolvedCodexHome = resolve(context.codexHome);
    const resolvedTarget = resolve(resolvedWorkspace, targetPath);

    // A link named .codex still makes Codex read the folder it points at, so this is checked before links are resolved.
    if (isInsideFolder(resolvedCodexHome, resolvedTarget) || isInsideCodexFolder(resolvedWorkspace, resolvedTarget)) {
        return true;
    }

    const realTarget = realPathOfChange(resolvedTarget);
    const realHome = realPathOrUndefined(resolvedCodexHome);
    const realWorkspace = realPathOrUndefined(resolvedWorkspace);

    if (realTarget === undefined || realHome === undefined || realWorkspace === undefined) {
        return true;
    }

    return isInsideFolder(realHome, realTarget) || isInsideCodexFolder(realWorkspace, realTarget);
}

function normalizeForMatch(text: string): string {
    return text.replaceAll('\\', '/')
        .toLowerCase();
}

function namesForbiddenLocation(text: string, context: CodexRequestContext): boolean {
    const normalizedText = normalizeForMatch(text);
    const rawHome = normalizeForMatch(context.codexHome);
    const resolvedCodexHome = resolve(context.codexHome);
    const resolvedHome = normalizeForMatch(resolvedCodexHome);

    return normalizedText.includes(rawHome) || normalizedText.includes(resolvedHome) || CODEX_FOLDER_PATTERN.test(text);
}

function fileChangePaths(change: CodexFileChange): string[] {
    if (change.kind.type === 'update' && change.kind.move_path !== null) {
        return [change.path, change.kind.move_path];
    }

    return [change.path];
}

function isForbiddenFileChange(change: CodexFileChange, context: CodexRequestContext): boolean {
    const paths = fileChangePaths(change);

    return paths.some(targetPath => isForbiddenPath(targetPath, context));
}

// A wrapped command with a quote inside is kept whole, since the inner text could not be read back exactly.
function unwrapShellCommand(command: string): string {
    const match = SHELL_WRAPPER_PATTERN.exec(command);

    return match?.[1] ?? match?.[2] ?? command;
}

// A review that throws, or does not answer in time, is a refusal. A Codex call is never let through by a failure.
// A stop before or during the review is a refusal too. A review that answers without looking at the signal, such as a
// rule match, could otherwise allow a call after the turn was stopped.
async function reviewInTime(call: ToolCall, context: CodexRequestContext): Promise<boolean> {
    if (isStopped(context.signal)) {
        return false;
    }

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
        const isAllowed = await Promise.race([reviewed, timedOut]);

        return isAllowed && !isStopped(context.signal);
    } finally {
        clearTimeout(timer);
    }
}

// Reads the flag at call time. A check after an await is not narrowed to the value read before it.
function isStopped(signal: AbortSignal): boolean {
    return signal.aborted;
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

    // This is a floor, not a parser. A command that builds the path at run time, such as one that derives it from
    // HOME, gets past it. The review still sees such a command.
    if (namesForbiddenLocation(unwrapped, context) || namesForbiddenLocation(cwd, context)) {
        return DECLINE_COMMAND;
    }

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

    // Codex loads its config and sign-in from the Codex home, and a project .codex folder when the project is
    // trusted. A write there could make Codex run a program without a review next turn, so it never reaches one.
    if (item.changes.some(change => isForbiddenFileChange(change, context))) {
        return DECLINE_COMMAND;
    }

    const calls = item.changes.flatMap(fileChangeCalls);
    const allAllowedSoFar = Promise.resolve(true);
    const isAllowed = await calls.reduce<Promise<boolean>>(
        async (previous, call) => (await previous) && reviewInTime(call, context),
        allAllowedSoFar,
    );
    // Codex may send a newer patch (item/fileChange/patchUpdated) while the review runs. The accept would then apply
    // changes nobody reviewed, so a patch that changed during its review is declined.
    const isSamePatch = itemId !== undefined && context.findItem(itemId) === item;

    return isAllowed && isSamePatch ? ACCEPT_COMMAND : DECLINE_COMMAND;
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

function findServer(params: Record<string, unknown>, context: CodexRequestContext): CodexToolServer | undefined {
    const servers = context.toolServer === undefined ? context.remoteServers ?? [] : [context.toolServer, ...(context.remoteServers ?? [])];

    return servers.find(server => server.name === params.serverName);
}

// A tool is blocked by its full name, or by the server prefix, which covers every tool of that server.
function isBlocked(server: CodexToolServer, toolName: string): boolean {
    return server.blockedTools.includes(toolName) || server.blockedTools.includes(`mcp__${server.name}`);
}

async function answerToolQuestion(params: Record<string, unknown>, context: CodexRequestContext): Promise<CodexAnswer> {
    const server = findServer(params, context);
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

    if (isBlocked(server, toolName) || !context.hasStepsLeft()) {
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
// Only a tool call question for the bot's own server or a connected server of the turn is reviewed.
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
