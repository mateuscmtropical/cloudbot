import type { AgentEvent } from './AgentEvent.ts';

interface TurnRequest {
    botId: string;
    workspaceDir: string;
    prompt: string;
    sessionId?: string;
    systemPrompt?: string;
    abortSignal: AbortSignal;
}

interface AgentRunner {
    runTurn(request: TurnRequest): AsyncIterable<AgentEvent>;
}

export type { AgentRunner, TurnRequest };
