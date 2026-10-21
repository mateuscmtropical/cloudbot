import { Readable } from 'node:stream';
import { USAGE_LIMIT_ERROR_PREFIXES, query } from '@anthropic-ai/claude-agent-sdk';
import type {
    HookCallback,
    PreToolUseHookInput,
    Options,
    SDKAssistantMessage,
    SDKMessage,
    SDKPartialAssistantMessage,
    SDKRateLimitInfo,
    SDKResultMessage,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, TurnErrorEvent } from './AgentEvent.ts';
import type { AgentRunner, ToolCallDecision, TurnImage, TurnRequest } from './AgentRunner.ts';
import { buildAgentEnvironment, createAgentUserSpawn } from './createAgentUserSpawn.ts';
import { validateAgentIsolation } from './buildClaudeCommand.ts';
import { prepareAgentWorkspace } from './prepareAgentWorkspace.ts';

type SdkQueryFunction = (parameters: { prompt: string | AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<SDKMessage>;

interface SdkAgentRunnerOptions {
    agentUser?: string | undefined;
    pathToClaudeCodeExecutable?: string | undefined;
    environment?: Record<string, string>;
    // Tests inject a fake here. Production leaves it out and uses the SDK query.
    queryFunction?: SdkQueryFunction;
}

type AssistantContentBlock = SDKAssistantMessage['message']['content'][number];
type UserContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number];
type ToolResultBlock = Extract<UserContentBlock, { type: 'tool_result' }>;

const MAX_TOOL_OUTPUT_LENGTH = 500;

function mapSdkMessage(message: SDKMessage): AgentEvent[] {
    switch (message.type) {
        case 'system':
            return message.subtype === 'init'
                ? [{ type: 'session', sessionId: message.session_id }]
                : [];
        case 'stream_event':
            return mapStreamEvent(message);
        case 'assistant':
            return mapAssistantMessage(message);
        case 'user':
            return mapUserMessage(message);
        case 'result':
            return mapResultMessage(message);
        case 'rate_limit_event':
            return mapRateLimitInfo(message.rate_limit_info);
        default:
            return [];
    }
}

function mapStreamEvent(message: SDKPartialAssistantMessage): AgentEvent[] {
    const { event } = message;

    if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
        return [];
    }

    return [{ type: 'text_delta', text: event.delta.text }];
}

function mapAssistantMessage(message: SDKAssistantMessage): AgentEvent[] {
    // An errored turn carries the error text as an assistant message. Skip it
    // here, because the result message reports the same failure once.
    if (message.error !== undefined) {
        return [];
    }

    const blockEvents = message.message.content.map(mapAssistantBlock);

    return blockEvents.flat();
}

function mapAssistantBlock(block: AssistantContentBlock): AgentEvent[] {
    switch (block.type) {
        case 'text':
            return [{ type: 'text', text: block.text }];
        case 'tool_use':
            return [{ type: 'tool_started', toolUseId: block.id, toolName: block.name, input: block.input }];
        default:
            return [];
    }
}

function mapUserMessage(message: SDKUserMessage): AgentEvent[] {
    const content = message.message.content;

    if (typeof content === 'string') {
        return [];
    }

    const blockEvents = content.map(mapUserBlock);

    return blockEvents.flat();
}

function mapUserBlock(block: UserContentBlock): AgentEvent[] {
    if (block.type !== 'tool_result') {
        return [];
    }

    const output = summarizeToolResult(block.content);

    return [{ type: 'tool_finished', toolUseId: block.tool_use_id, isError: block.is_error === true, output }];
}

function summarizeToolResult(content: ToolResultBlock['content']): string {
    const fullText = extractToolResultText(content);

    return fullText.slice(0, MAX_TOOL_OUTPUT_LENGTH);
}

function extractToolResultText(content: ToolResultBlock['content']): string {
    if (typeof content === 'string') {
        return content;
    }

    if (content === undefined) {
        return '';
    }

    const textParts = content.flatMap(part => (part.type === 'text' ? [part.text] : []));

    return textParts.join('\n');
}

function mapResultMessage(message: SDKResultMessage): AgentEvent[] {
    if (message.subtype === 'success' && !message.is_error) {
        return [{ type: 'turn_finished', costUsd: message.total_cost_usd, durationMs: message.duration_ms }];
    }

    // The SDK stops a turn at maxTurns or maxBudgetUsd and reports it as its own subtype, not as an error text.
    if (message.subtype === 'error_max_turns') {
        return [{ type: 'turn_limit', limit: 'steps' }];
    }

    if (message.subtype === 'error_max_budget_usd') {
        return [{ type: 'turn_limit', limit: 'spending' }];
    }

    // The SDK result has no typed usage limit field. Usage limit errors show up
    // as text, so this matches the SDK's own list of usage limit messages.
    // Heuristic: a new wording from Anthropic can slip past it.
    const errorDetail = message.subtype === 'success' ? message.result : message.errors.join('\n');
    const errorText = errorDetail || 'The turn ended with an error.';

    return [{ type: 'turn_error', message: errorText, isUsageLimit: isUsageLimitText(errorText) }];
}

function isUsageLimitText(text: string): boolean {
    return USAGE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix));
}

function mapRateLimitInfo(rateLimitInfo: SDKRateLimitInfo): AgentEvent[] {
    // The SDK sends resetsAt in unix epoch seconds. The SDK type does not say so,
    // but the bundled CLI documents it that way. Our events use milliseconds.
    const resetsAtOption = rateLimitInfo.resetsAt === undefined
        ? {}
        : { resetsAt: rateLimitInfo.resetsAt * 1000 };

    return [{ type: 'rate_limit', status: rateLimitInfo.status, ...resetsAtOption }];
}

function rememberResetsAt(agentEvent: AgentEvent, previousResetsAt: number | undefined): number | undefined {
    if (agentEvent.type === 'rate_limit' && agentEvent.resetsAt !== undefined) {
        return agentEvent.resetsAt;
    }

    return previousResetsAt;
}

function withResetsAt(agentEvent: AgentEvent, latestResetsAt: number | undefined): AgentEvent {
    if (agentEvent.type !== 'turn_error' || !agentEvent.isUsageLimit || latestResetsAt === undefined) {
        return agentEvent;
    }

    return { ...agentEvent, resetsAt: latestResetsAt };
}

// A call may wait for the owner, so the hook outlasts the one hour wait of the approval gate.
const REVIEW_HOOK_TIMEOUT_SECONDS = 3900;

// A hook that throws may let the call run, so any failure of the review becomes a refusal.
async function decideReview(
    reviewToolCall: NonNullable<TurnRequest['reviewToolCall']>,
    input: PreToolUseHookInput,
    signal: AbortSignal,
): Promise<ToolCallDecision> {
    try {
        return await reviewToolCall({ toolName: input.tool_name, input: input.tool_input }, signal);
    } catch {
        return { isAllowed: false, reason: 'This action could not be reviewed, so it was not run.' };
    }
}

// PreToolUse runs for every tool, including the ones allowedTools lets through. Only a refusal changes the outcome.
// The SDK types say the hook input carries agent_id "only when the hook fires from within a subagent (e.g., a tool
// called by an AgentTool worker)" (BaseHookInput in node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts). So helper
// calls reach this review hook too, and the review does not skip them.
function buildReviewHooks(
    reviewToolCall: NonNullable<TurnRequest['reviewToolCall']>,
    turnSignal: AbortSignal,
): NonNullable<Options['hooks']> {
    const reviewHook: HookCallback = async (input, _toolUseId, hookOptions) => {
        if (input.hook_event_name !== 'PreToolUse') {
            return {};
        }

        const signal = AbortSignal.any([hookOptions.signal, turnSignal]);
        const decision = await decideReview(reviewToolCall, input, signal);

        if (decision.isAllowed) {
            return {};
        }

        return {
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: decision.reason,
            },
        };
    };

    return { PreToolUse: [{ hooks: [reviewHook], timeout: REVIEW_HOOK_TIMEOUT_SECONDS }] };
}

// The SDK types do not say that the top-level disallowedTools reaches helper agents. This hook refuses a blocked
// tool for every agent, so an owner's block holds inside a helper whatever the SDK does.
function buildBlockedToolHooks(blockedToolNames: string[]): NonNullable<Options['hooks']> {
    const blockedToolHook: HookCallback = (input) => {
        const isBlocked = input.hook_event_name === 'PreToolUse' && blockedToolNames.includes(input.tool_name);

        if (!isBlocked) {
            return Promise.resolve({});
        }

        return Promise.resolve({
            hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'The owner blocked this tool.',
            },
        });
    };

    return { PreToolUse: [{ hooks: [blockedToolHook] }] };
}

function buildToolHooks(request: TurnRequest): NonNullable<Options['hooks']> | undefined {
    const blockedToolNames = request.disallowedTools ?? [];
    const blockedHooks = request.agents !== undefined && blockedToolNames.length > 0
        ? buildBlockedToolHooks(blockedToolNames).PreToolUse ?? []
        : [];
    const reviewHooks = request.reviewToolCall === undefined
        ? []
        : buildReviewHooks(request.reviewToolCall, request.abortSignal).PreToolUse ?? [];
    const preToolUseHooks = [...blockedHooks, ...reviewHooks];

    return preToolUseHooks.length === 0 ? undefined : { PreToolUse: preToolUseHooks };
}

function buildQueryOptions(
    request: TurnRequest,
    runnerOptions: SdkAgentRunnerOptions,
    abortController: AbortController,
    onStderrTail?: (tail: string) => void,
): Options {
    const executableOption = runnerOptions.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: runnerOptions.pathToClaudeCodeExecutable }
        : {};
    // Without env the SDK subprocess inherits process.env, and with env it replaces the whole environment, so the caller must pass PATH and HOME too.
    // The turn's extra variables, such as the GitHub proxy addresses, are added to the same environment.
    const extraEnvironment = request.extraEnvironment ?? {};
    const environmentOption = runnerOptions.agentUser
        ? { env: buildAgentEnvironment(runnerOptions.agentUser, runnerOptions.environment, extraEnvironment) }
        : runnerOptions.environment ? { env: { ...runnerOptions.environment, ...extraEnvironment } } : {};
    const spawnOption = runnerOptions.agentUser
        ? {
                spawnClaudeCodeProcess: createAgentUserSpawn({
                    user: runnerOptions.agentUser,
                    executable: runnerOptions.pathToClaudeCodeExecutable ?? '',
                    environment: runnerOptions.environment,
                    extraEnvironment,
                    onStderrTail,
                }),
            }
        : {};
    const resumeOption = request.sessionId ? { resume: request.sessionId } : {};
    const modelOption = request.model === undefined ? {} : { model: request.model };
    const effortOption = request.effort === undefined ? {} : { effort: request.effort };
    // Helper agents run their own tool calls, which the PreToolUse review hook below also sees.
    const agentsOption = request.agents === undefined ? {} : { agents: request.agents };
    // A plain string systemPrompt would replace Claude Code's default prompt, so the bot profile is appended to the preset.
    const systemPromptAppendOption = request.systemPrompt ? { append: request.systemPrompt } : {};
    const systemPromptOption = {
        systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            ...systemPromptAppendOption,
        },
    };
    const mcpServersOption = request.mcpServers ? { mcpServers: request.mcpServers } : {};
    // Headless turns cannot answer a permission prompt, so the bot's own tools are allowed up front.
    const allowedToolsOption = request.allowedTools ? { allowedTools: request.allowedTools } : {};
    const disallowedToolsOption = request.disallowedTools && request.disallowedTools.length > 0
        ? { disallowedTools: request.disallowedTools }
        : {};
    // Extra folders the agent may read, such as the upload folder of the bot.
    const additionalDirectoriesOption = request.additionalDirectories ? { additionalDirectories: request.additionalDirectories } : {};
    // The SDK counts the steps of the main loop and the spending of the query, and stops the turn at either limit.
    const maxStepsOption = request.maxSteps === undefined ? {} : { maxTurns: request.maxSteps };
    const maxSpendOption = request.maxSpendUsd === undefined ? {} : { maxBudgetUsd: request.maxSpendUsd };

    const toolHooks = buildToolHooks(request);
    const hooksOption = toolHooks === undefined ? {} : { hooks: toolHooks };

    return {
        cwd: request.workspaceDir,
        abortController,
        includePartialMessages: true,
        ...executableOption,
        ...environmentOption,
        ...spawnOption,
        ...resumeOption,
        ...modelOption,
        ...effortOption,
        ...agentsOption,
        ...systemPromptOption,
        ...mcpServersOption,
        ...allowedToolsOption,
        ...disallowedToolsOption,
        ...additionalDirectoriesOption,
        ...maxStepsOption,
        ...maxSpendOption,
        ...hooksOption,
    };
}

// With images, the SDK takes a stream of user messages. Its first message carries the text and the images.
function createImageMessages(text: string, images: TurnImage[]): AsyncIterable<SDKUserMessage> {
    const textBlock = { type: 'text' as const, text };
    const imageBlocks = images.map(image => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
    }));

    const message: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: [textBlock, ...imageBlocks] },
        parent_tool_use_id: null,
    };

    return Readable.from([message]);
}

function buildPrompt(request: TurnRequest): string | AsyncIterable<SDKUserMessage> {
    const images = request.images ?? [];

    if (images.length === 0) {
        return request.prompt;
    }

    return createImageMessages(request.prompt, images);
}

class SdkAgentRunner implements AgentRunner {
    private readonly runnerOptions: SdkAgentRunnerOptions;
    private readonly queryFunction: SdkQueryFunction;

    constructor(options: SdkAgentRunnerOptions) {
        const agentUser = options.agentUser ?? process.env.CLOUDBOT_AGENT_USER;
        const pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable ?? process.env.CLAUDE_PATH;

        validateAgentIsolation(agentUser);

        this.runnerOptions = { ...options, agentUser, pathToClaudeCodeExecutable };
        this.queryFunction = options.queryFunction ?? query;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        // An abort event that already fired is never seen again, so check the state first.
        if (request.abortSignal.aborted) {
            return;
        }

        const abortController = new AbortController();
        const forwardAbort = (): void => {
            abortController.abort();
        };
        const diagnostics = { stderrTail: '' };
        const onStderrTail = (tail: string): void => {
            diagnostics.stderrTail = tail;
        };

        request.abortSignal.addEventListener('abort', forwardAbort, { once: true });

        let latestResetsAt: number | undefined;

        try {
            if (this.runnerOptions.agentUser) {
                try {
                    await prepareAgentWorkspace(request.workspaceDir);
                } catch (error: unknown) {
                    console.error('Could not prepare the agent workspace:', error);
                    yield { type: 'turn_error', message: 'Could not prepare the agent workspace. Please try again.', isUsageLimit: false };

                    return;
                }
            }

            const queryOptions = buildQueryOptions(request, this.runnerOptions, abortController, onStderrTail);
            const prompt = buildPrompt(request);
            const conversation = this.queryFunction({ prompt, options: queryOptions });

            // The SDK's Query is an async iterator, so `for await` is the only
            // loop form that fits. Plain loops are banned by lint.
            for await (const sdkMessage of conversation) {
                const agentEvents = mapSdkMessage(sdkMessage);

                // A message that maps to no event still shows the turn is alive, such as tool progress or a retry.
                const mappedEvents: AgentEvent[] = agentEvents.length === 0 ? [{ type: 'activity' }] : agentEvents;

                mappedEvents.forEach((agentEvent) => {
                    latestResetsAt = rememberResetsAt(agentEvent, latestResetsAt);
                });

                const turnEvents = mappedEvents.map(agentEvent => withResetsAt(agentEvent, latestResetsAt));

                yield* turnEvents;
            }
        } catch (error: unknown) {
            // Aborting the turn makes the SDK throw. That is a stop, not an error.
            // The controller is checked, not the request signal: the top-of-method check narrows the signal.
            if (abortController.signal.aborted) {
                return;
            }

            const message = error instanceof Error ? error.message : String(error);
            const errorEvent: TurnErrorEvent = { type: 'turn_error', message, isUsageLimit: isUsageLimitText(message) };

            if (diagnostics.stderrTail) {
                // Keep untrusted CLI text on one quoted line in error reports.
                const report = JSON.stringify(diagnostics);

                console.error('Agent process diagnostics:', report);
            }

            yield withResetsAt(errorEvent, latestResetsAt);
        } finally {
            request.abortSignal.removeEventListener('abort', forwardAbort);
        }
    }
}

export { SdkAgentRunner, buildQueryOptions, mapSdkMessage };
export type { SdkAgentRunnerOptions, SdkQueryFunction };
