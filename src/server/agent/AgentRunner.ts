import type { AgentEvent } from './AgentEvent.ts';
import type { LoopbackTool } from './createLoopbackToolServer.ts';

// A helper agent of the main turn, written to the CLI as one entry of its --agents file.
interface AgentDefinition {
    description: string;
    prompt: string;
    model?: string | undefined;
    tools?: string[] | undefined;
    disallowedTools?: string[] | undefined;
    effort?: string | undefined;
}

// A remote MCP server of the owner, written to the CLI as one entry of its MCP config.
type McpServerConfig
    = | { type?: 'stdio' | undefined; command: string; args?: string[] | undefined; env?: Record<string, string> | undefined }
        | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> | undefined };

type TurnImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface TurnImage {
    mediaType: TurnImageMediaType;
    data: string;
}

interface ToolCall {
    toolName: string;
    input: unknown;
}

// isAllowed false refuses the call. The reason goes to the model.
// isOwnerDenial marks the owner's own Deny. Only that refusal holds for the same call again in the turn.
type ToolCallDecision = { isAllowed: true } | { isAllowed: false; reason: string; isOwnerDenial?: boolean };

interface TurnRequest {
    botId: string;
    workspaceDir: string;
    prompt: string;
    sessionId?: string;
    // A model id, or null for a provider default. Unset keeps the engine default.
    model?: string | null;
    // An effort id, or null for a provider default. Unset keeps the engine default.
    effort?: string | null;
    // Saved provider defaults let an engine restore a choice after its process restarts.
    providerDefaultModel?: string | null;
    providerDefaultEffort?: string | null;
    // Rejects an engine catalog response that belongs to an older provider auth method.
    providerModelRevision?: number;
    // Helper agents the main turn can hand work to. Each has its own model and tools.
    agents?: Record<string, AgentDefinition>;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    // Bot tools served over the loopback MCP endpoint. The CLI calls them.
    tools?: LoopbackTool[];
    allowedTools?: string[];
    // Tools the owner blocked. The CLI refuses them even when allowedTools names them.
    disallowedTools?: string[];
    // Called before each tool call. It may wait, for example for the owner. The signal fires when the turn stops.
    reviewToolCall?: (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;
    images?: TurnImage[];
    additionalDirectories?: string[];
    // The most agent steps the turn may take. Unset means no limit. The CLI stops the turn at it.
    maxSteps?: number;
    // The most the turn may spend, in estimated US dollars. Unset means no limit. The CLI stops the turn at it.
    maxSpendUsd?: number;
    // Variables added to the agent's environment for this turn, such as the GitHub proxy addresses. Only the server sets them.
    extraEnvironment?: Record<string, string>;
    // The chat hands the running turn new messages of the owner through it. Unset keeps every new message in the queue.
    inbox?: TurnInbox;
    abortSignal: AbortSignal;
}

// An engine that can take a message in the middle of a turn sets deliver while its input is open, and clears it when the input
// closes. deliver returns false when the turn can no longer take the message, so the chat queues it instead.
interface TurnInbox {
    deliver?: ((text: string) => boolean) | undefined;
}

interface AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent>;
}

export type { AgentDefinition, AgentRunner, McpServerConfig, ToolCall, ToolCallDecision, TurnImage, TurnImageMediaType, TurnInbox, TurnRequest };
