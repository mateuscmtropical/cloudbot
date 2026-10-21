import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent } from './AgentEvent.ts';

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
type ToolCallDecision = { isAllowed: true } | { isAllowed: false; reason: string };

interface TurnRequest {
    botId: string;
    workspaceDir: string;
    prompt: string;
    sessionId?: string;
    // An alias or full model id from the owner's model choices. Unset keeps the CLI default.
    model?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    allowedTools?: string[];
    // Tools the owner blocked. The SDK refuses them even when allowedTools names them.
    disallowedTools?: string[];
    // Called before each tool call. It may wait, for example for the owner. The signal fires when the turn stops.
    reviewToolCall?: (call: ToolCall, signal: AbortSignal) => Promise<ToolCallDecision>;
    images?: TurnImage[];
    additionalDirectories?: string[];
    abortSignal: AbortSignal;
}

interface AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent>;
}

export type { AgentRunner, ToolCall, ToolCallDecision, TurnImage, TurnImageMediaType, TurnRequest };
