import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent } from './AgentEvent.ts';

type TurnImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface TurnImage {
    mediaType: TurnImageMediaType;
    data: string;
}

interface TurnRequest {
    botId: string;
    workspaceDir: string;
    prompt: string;
    sessionId?: string;
    systemPrompt?: string;
    mcpServers?: Record<string, McpServerConfig>;
    allowedTools?: string[];
    images?: TurnImage[];
    additionalDirectories?: string[];
    abortSignal: AbortSignal;
}

interface AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent>;
}

export type { AgentRunner, TurnImage, TurnImageMediaType, TurnRequest };
