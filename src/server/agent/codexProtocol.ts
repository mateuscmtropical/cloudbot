// The parts of the Codex app-server protocol that CloudBot uses. The shapes come from the bindings that
// `codex app-server generate-ts` writes for codex-cli 0.163.0, cut down to the fields read here. Every message is
// one JSON line on stdio. Answers carry the id of the request and no method.

// The Codex version these shapes and the canary were checked against.
const CODEX_PROTOCOL_VERSION = '0.163.0';

// Every built-in tool that runs a command or edits a file asks first. "on-request" lets most commands run unasked.
const CODEX_APPROVAL_POLICY = 'untrusted';
const CODEX_SANDBOX_MODE = 'workspace-write';

// Built-ins that have no per-call approval are turned off, so the model is never offered them:
// hosted web search, reading any image file, helper agents and goals. Shell commands also do not get
// CODEX_HOME, so a command cannot read the config or sign-in folder through that variable.
const CODEX_LOCKED_CONFIG = [
    'web_search="disabled"',
    'features.view_image=false',
    'features.multi_agent=false',
    'features.goals=false',
    'shell_environment_policy.exclude=["CODEX_HOME"]',
];

type CodexRequestId = string | number;

interface CodexFileChange {
    path: string;
    kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
    diff: string;
}

interface CodexAgentMessageItem {
    type: 'agentMessage';
    id: string;
    text: string;
}

interface CodexCommandItem {
    type: 'commandExecution';
    id: string;
    command: string;
    status: string;
    aggregatedOutput: string | null;
    exitCode: number | null;
}

interface CodexFileChangeItem {
    type: 'fileChange';
    id: string;
    changes: CodexFileChange[];
    status: string;
}

interface CodexMcpToolCallItem {
    type: 'mcpToolCall';
    id: string;
    server: string;
    tool: string;
    status: string;
    arguments: unknown;
}

// Any other kind of item, such as reasoning. It is kept by id but not shown.
interface CodexOtherItem {
    type: string;
    id?: string;
}

type CodexThreadItem = CodexAgentMessageItem | CodexCommandItem | CodexFileChangeItem | CodexMcpToolCallItem | CodexOtherItem;

function isAgentMessageItem(item: CodexThreadItem): item is CodexAgentMessageItem {
    return item.type === 'agentMessage' && typeof (item as Partial<CodexAgentMessageItem>).text === 'string';
}

function isCommandItem(item: CodexThreadItem): item is CodexCommandItem {
    return item.type === 'commandExecution' && typeof (item as Partial<CodexCommandItem>).command === 'string';
}

function isFileChangeItem(item: CodexThreadItem): item is CodexFileChangeItem {
    return item.type === 'fileChange' && Array.isArray((item as Partial<CodexFileChangeItem>).changes);
}

function isMcpToolCallItem(item: CodexThreadItem): item is CodexMcpToolCallItem {
    return item.type === 'mcpToolCall' && typeof (item as Partial<CodexMcpToolCallItem>).server === 'string';
}

interface CodexTurnError {
    message: string;
    // A string such as usageLimitExceeded, or an object for the connection failures.
    codexErrorInfo: unknown;
}

interface CodexTurn {
    id: string;
    status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
    error: CodexTurnError | null;
    durationMs: number | null;
}

interface CodexMessage {
    id?: CodexRequestId;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

export { CODEX_APPROVAL_POLICY, CODEX_LOCKED_CONFIG, CODEX_PROTOCOL_VERSION, CODEX_SANDBOX_MODE, isAgentMessageItem, isCommandItem, isFileChangeItem, isMcpToolCallItem };
export type { CodexCommandItem, CodexFileChange, CodexFileChangeItem, CodexMessage, CodexRequestId, CodexThreadItem, CodexTurn, CodexTurnError };
