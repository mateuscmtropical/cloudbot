import { USAGE_LIMIT_ERROR_PREFIXES, query } from '@anthropic-ai/claude-agent-sdk';
import type {
    Options,
    SDKAssistantMessage,
    SDKMessage,
    SDKPartialAssistantMessage,
    SDKRateLimitInfo,
    SDKResultMessage,
    SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, TurnErrorEvent } from './AgentEvent.ts';
import type { AgentRunner, TurnRequest } from './AgentRunner.ts';

type SdkQueryFunction = (parameters: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

interface SdkAgentRunnerOptions {
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

function buildQueryOptions(
    request: TurnRequest,
    runnerOptions: SdkAgentRunnerOptions,
    abortController: AbortController,
): Options {
    const executableOption = runnerOptions.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: runnerOptions.pathToClaudeCodeExecutable }
        : {};
    // Without env the SDK subprocess inherits process.env, and with env it replaces the whole environment, so the caller must pass PATH and HOME too.
    const environmentOption = runnerOptions.environment ? { env: runnerOptions.environment } : {};
    const resumeOption = request.sessionId ? { resume: request.sessionId } : {};
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

    return {
        cwd: request.workspaceDir,
        abortController,
        includePartialMessages: true,
        ...executableOption,
        ...environmentOption,
        ...resumeOption,
        ...systemPromptOption,
        ...mcpServersOption,
        ...allowedToolsOption,
    };
}

class SdkAgentRunner implements AgentRunner {
    private readonly runnerOptions: SdkAgentRunnerOptions;
    private readonly queryFunction: SdkQueryFunction;

    constructor(options: SdkAgentRunnerOptions) {
        this.runnerOptions = options;
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

        request.abortSignal.addEventListener('abort', forwardAbort, { once: true });

        const queryOptions = buildQueryOptions(request, this.runnerOptions, abortController);
        const conversation = this.queryFunction({ prompt: request.prompt, options: queryOptions });
        let latestResetsAt: number | undefined;

        try {
            // The SDK's Query is an async iterator, so `for await` is the only
            // loop form that fits. Plain loops are banned by lint.
            for await (const sdkMessage of conversation) {
                const agentEvents = mapSdkMessage(sdkMessage);

                agentEvents.forEach((agentEvent) => {
                    latestResetsAt = rememberResetsAt(agentEvent, latestResetsAt);
                });

                const turnEvents = agentEvents.map(agentEvent => withResetsAt(agentEvent, latestResetsAt));

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

            yield withResetsAt(errorEvent, latestResetsAt);
        } finally {
            request.abortSignal.removeEventListener('abort', forwardAbort);
        }
    }
}

export { SdkAgentRunner, buildQueryOptions, mapSdkMessage };
export type { SdkAgentRunnerOptions, SdkQueryFunction };
