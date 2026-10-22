import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { namesProtectedFolder, toReviewedCall } from './AcpEngine.ts';
import type { AcpLaunch } from './AcpEngine.ts';
import type { AgentEvent } from './AgentEvent.ts';
import type { AgentRunner, ToolCall, ToolCallDecision, TurnRequest } from './AgentRunner.ts';
import type { LoopbackTool, LoopbackToolServer } from './createLoopbackToolServer.ts';
import { PROFILE_SERVER_NAME } from './createProfileToolServer.ts';
import { prepareAgentWorkspace } from './prepareAgentWorkspace.ts';

interface AgyEngineOptions {
    // The name the chat shows, such as Gemini.
    label: string;
    // The root-owned wrapper and its arguments that start agy in headless stream-json mode, see docker/cloudbot-provider.
    command: string;
    args: string[];
    launch: AcpLaunch;
    loopback: LoopbackToolServer;
    // Folders agy loads its sign-in, hooks and config from. A call that names one is refused without a review.
    protectedFolders: string[];
}

interface AgyStep {
    step_index?: number;
    state?: string;
    step_type?: string;
    tool_name?: string;
    text_delta?: string;
    tool_info?: { name?: string; parameters?: unknown; output?: unknown; error?: { message?: string } };
}

interface AgyResult {
    status?: string;
    error?: string;
}

interface AgyLine {
    event?: string;
    conversation_id?: string;
    step_update?: AgyStep;
    result?: AgyResult;
}

// The kind of each agy tool, so the CloudBot rules check commands, paths and links the same way as for Claude.
// Tools not listed are reviewed under their own name with all their arguments.
const AGY_KINDS: Record<string, string> = {
    run_command: 'execute',
    send_command_input: 'execute',
    notebook_execution: 'execute',
    write_file: 'edit',
    write_to_file: 'edit',
    edit_file: 'edit',
    replace_file_content: 'edit',
    multi_replace_file_content: 'edit',
    sed_file: 'edit',
    notebook_edit: 'edit',
    read_file: 'read',
    view_file: 'read',
    list_dir: 'read',
    grep_search: 'search',
    find_by_name: 'search',
    read_url_content: 'fetch',
};
// agy services that would act outside the turn or outside CloudBot, like its schedules, workflows, messages and
// subagents, which run on their own. CloudBot refuses them, as it does the same Claude CLI services.
const REFUSED_TOOLS = new Set([
    'schedule', 'manage_task', 'run_workflow', 'send_message', 'manage_inbox', 'list_plugin_accounts', 'search_marketplace',
    'define_subagent', 'invoke_subagent', 'manage_subagents', 'browser_subagent', 'delete_knowledge',
]);
const REFUSED_REASON = 'CloudBot does not allow this agy service. Use CloudBot routines and tools instead.';
const PROTECTED_REASON = 'This call names a folder that holds the agent sign-in or config, so it was refused.';
const REVIEW_FAILED_REASON = 'CloudBot could not review this call, so it was refused.';
// agy prints this to stderr when it has no saved sign-in.
const NOT_SIGNED_IN = /authentication required|not signed in|log in/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The owner's model choices hold Claude names, which agy does not take, so only a Gemini slug is passed on.
const MODEL_SLUG = /^gemini-[a-z0-9.-]{1,58}$/;
const MODEL_LEVEL = /-(low|medium|high)$/;
const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function readRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function readString(record: Record<string, unknown>, ...names: string[]): string | undefined {
    const found = names.map(name => record[name])
        .find(value => typeof value === 'string');

    return typeof found === 'string' ? found : undefined;
}

// agy names arguments like CommandLine and Path. They are copied to the names the CloudBot rules read.
function toAgyCall(name: string, args: unknown): Parameters<typeof toReviewedCall>[0] {
    const input = readRecord(args);
    const command = readString(input, 'CommandLine', 'Input', 'Command');
    const path = readString(input, 'Path', 'TargetFile', 'AbsolutePath', 'SearchPath', 'DirectoryPath', 'File');
    const url = readString(input, 'Url', 'URL');
    const pattern = readString(input, 'Query', 'Pattern', 'SearchPattern');
    const named = {
        ...input,
        ...(command === undefined ? {} : { command }),
        ...(path === undefined ? {} : { path }),
        ...(url === undefined ? {} : { url }),
        ...(pattern === undefined ? {} : { pattern }),
    };

    return { name, title: name, kind: AGY_KINDS[name] ?? null, rawInput: named, ...(path === undefined ? {} : { locations: [{ path }] }) };
}

// A call to the bot's own tools goes through call_mcp_tool. The loopback server reviews it when it runs.
function isOwnToolCall(name: string, args: unknown): boolean {
    const input = readRecord(args);

    return name === 'call_mcp_tool' && readString(input, 'ServerName', 'serverName', 'server_name', 'Server') === PROFILE_SERVER_NAME;
}

// Reads the flag at call time. A check after an await is not narrowed to the value read before it.
function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
}

function outputText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    return value === undefined ? '' : JSON.stringify(value);
}

// agy model slugs end with their level, such as gemini-3.8-flash-low. A slug without one takes it from the effort.
function toAgyModel(model: string | undefined, effort: string | undefined): string | undefined {
    if (model === undefined || !MODEL_SLUG.test(model)) {
        return undefined;
    }

    if (MODEL_LEVEL.test(model) || effort === undefined) {
        return model;
    }

    return `${model}-${effort === 'low' || effort === 'medium' ? effort : 'high'}`;
}

// agy calls MCP tools through call_mcp_tool without seeing their arguments, so it guessed wrong names. The prompt lists them.
function describeTools(tools: LoopbackTool[]): string {
    if (tools.length === 0) {
        return '';
    }

    const lines = tools.map(tool => `- ${tool.name}(${Object.keys(tool.inputSchema)
        .join(', ')})`);

    return `Your CloudBot tools run through call_mcp_tool with ServerName ${PROFILE_SERVER_NAME}, the tool name as ToolName and an Arguments object. These are the tools and their argument names:\n${lines.join('\n')}\n\n`;
}

// Runs a turn on the Antigravity CLI (agy), which Google points Gemini subscriptions to. agy runs headless with
// stream-json, and a PreToolUse hook (docker/agy-hook.js) sends each tool call to the same review as a Claude call
// before it runs. The hook answer is the only way a call runs, since headless agy refuses calls it cannot ask about.
class AgyEngine implements AgentRunner {
    private readonly options: AgyEngineOptions;

    constructor(options: AgyEngineOptions) {
        this.options = options;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        if (request.abortSignal.aborted) {
            return;
        }

        try {
            await prepareAgentWorkspace(request.workspaceDir);
        } catch {
            yield { type: 'turn_error', message: 'Could not prepare the agent workspace. Please try again.', isUsageLimit: false };

            return;
        }

        const review = request.reviewToolCall ?? ((): Promise<ToolCallDecision> => Promise.resolve({ isAllowed: false, reason: REVIEW_FAILED_REASON }));
        const toolTurn = this.options.loopback.grantTurn({
            tools: request.tools ?? [],
            reviewToolCall: (call, signal) => this.reviewCall(call, review, signal),
            disallowedTools: request.disallowedTools,
            offersPromptTool: false,
            reviewsEachCall: true,
        });
        const sessionId = request.sessionId !== undefined && UUID.test(request.sessionId) ? request.sessionId : undefined;
        const model = toAgyModel(request.model, request.effort);
        const effort = request.effort !== undefined && AGY_EFFORTS.has(request.effort) ? request.effort : undefined;
        const environment: Record<string, string> = {
            PATH: process.env.PATH ?? '',
            ...request.extraEnvironment,
            CLOUDBOT_TOOLS_TOKEN: toolTurn.token,
            CLOUDBOT_AGY_REVIEW_URL: toolTurn.mcpUrl,
            ...(sessionId === undefined ? {} : { CLOUDBOT_AGY_CONVERSATION: sessionId }),
            ...(model === undefined ? {} : { CLOUDBOT_AGY_MODEL: model }),
            ...(effort === undefined ? {} : { CLOUDBOT_AGY_EFFORT: effort }),
        };
        const child = this.options.launch.spawnFunction(this.options.command, this.options.args, {
            cwd: request.workspaceDir,
            env: environment,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: true,
            detached: true,
        });
        const stdout = child.stdout;

        if (stdout === null) {
            toolTurn.release();
            this.stop(child);
            yield { type: 'turn_error', message: `${this.options.label} could not start.`, isUsageLimit: false };

            return;
        }

        let errorText = '';
        const onAbort = (): void => {
            this.stop(child);
        };

        child.on('error', () => undefined);
        child.stdin?.on('error', () => undefined);
        child.stderr?.on('data', (chunk: Buffer) => {
            errorText = `${errorText}${chunk.toString('utf8')}`.slice(-4000);
        });
        request.abortSignal.addEventListener('abort', onAbort, { once: true });

        const instructions = request.systemPrompt === undefined ? '' : `${request.systemPrompt}\n\n`;
        const toolNote = describeTools(request.tools ?? []);
        const message = { event: 'user', message: { content: [{ type: 'text', text: `${instructions}${toolNote}${request.prompt}` }] } };

        child.stdin?.end(`${JSON.stringify(message)}\n`);

        // An object, so the check after the loop reads what the loop set.
        const progress = { isFinished: false };
        const textByStep = new Map<number, string>();

        try {
            const lines = createInterface({ input: stdout });

            // The lines are an async iterator, so `for await` is the only loop form that fits.
            for await (const line of lines) {
                const events = this.mapLine(line, textByStep);

                progress.isFinished = progress.isFinished || events.some(event => event.type === 'turn_finished' || event.type === 'turn_error');
                yield* events;
            }

            if (!progress.isFinished && !isAborted(request.abortSignal)) {
                const notSignedIn = NOT_SIGNED_IN.test(errorText);

                yield { type: 'turn_error', message: notSignedIn ? `${this.options.label} is not signed in. Ask me to connect ${this.options.label}.` : `${this.options.label} stopped before it answered.`, isUsageLimit: false };
            }
        } finally {
            request.abortSignal.removeEventListener('abort', onAbort);
            toolTurn.release();
            // Every path ends here, so the group is killed even after a clean end: an approved command may still run in it.
            this.stop(child);
        }
    }

    private stop(child: ChildProcess): void {
        this.options.launch.signalProcess(child, 'KILL');
    }

    private async reviewCall(call: ToolCall, review: NonNullable<TurnRequest['reviewToolCall']>, signal: AbortSignal): Promise<ToolCallDecision> {
        // The bot's own tools come from the loopback server under their full MCP name.
        if (call.toolName.startsWith('mcp__')) {
            return review(call, signal);
        }

        if (REFUSED_TOOLS.has(call.toolName)) {
            return { isAllowed: false, reason: REFUSED_REASON };
        }

        if (isOwnToolCall(call.toolName, call.input)) {
            return { isAllowed: true };
        }

        const agyCall = toAgyCall(call.toolName, call.input);

        if (namesProtectedFolder(agyCall, this.options.protectedFolders)) {
            return { isAllowed: false, reason: PROTECTED_REASON };
        }

        const reviewed = toReviewedCall(agyCall);

        return review(reviewed, signal);
    }

    private mapLine(line: string, textByStep: Map<number, string>): AgentEvent[] {
        let parsed: AgyLine;

        try {
            parsed = JSON.parse(line) as AgyLine;
        } catch {
            return [];
        }

        if (parsed.event === 'init' && parsed.conversation_id !== undefined && UUID.test(parsed.conversation_id)) {
            return [{ type: 'session', sessionId: parsed.conversation_id }];
        }

        if (parsed.event === 'result') {
            const result = parsed.result ?? {};

            if (result.status === 'SUCCESS') {
                return [{ type: 'turn_finished' }];
            }

            return [{ type: 'turn_error', message: result.error === undefined || result.error === '' ? `${this.options.label} could not finish the turn.` : `${this.options.label}: ${result.error}`, isUsageLimit: /quota|limit|exhausted/i.test(result.error ?? '') }];
        }

        const step = parsed.step_update;

        if (parsed.event !== 'step_update' || step === undefined) {
            return [];
        }

        if (step.step_type === 'agent_response') {
            // The chat shows the deltas live and saves only the full text, which is sent when the step is done.
            const stepIndex = step.step_index ?? 0;
            const delta = step.text_delta ?? '';
            const text = `${textByStep.get(stepIndex) ?? ''}${delta}`;
            const events: AgentEvent[] = delta === '' ? [] : [{ type: 'text_delta', text: delta }];

            if (step.state !== 'DONE') {
                textByStep.set(stepIndex, text);

                return events.length === 0 ? [{ type: 'activity' }] : events;
            }

            textByStep.delete(stepIndex);

            return text === '' ? [...events, { type: 'activity' }] : [...events, { type: 'text', text }];
        }

        if (step.step_type === 'tool') {
            const toolUseId = `agy-${String(step.step_index ?? 0)}`;
            const toolName = step.tool_info?.name ?? step.tool_name ?? 'tool';

            if (step.state === 'ACTIVE') {
                return [{ type: 'tool_started', toolUseId, toolName, input: step.tool_info?.parameters ?? {} }];
            }

            const isError = step.state === 'ERROR';

            return [{ type: 'tool_finished', toolUseId, isError, output: isError ? step.tool_info?.error?.message ?? 'The tool failed.' : outputText(step.tool_info?.output) }];
        }

        return [{ type: 'activity' }];
    }
}

export { AgyEngine, toAgyCall, toAgyModel };
export type { AgyEngineOptions };
