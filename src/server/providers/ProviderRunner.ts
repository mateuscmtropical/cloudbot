import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { PROVIDER_LABELS } from './providerIds.ts';
import type { ProviderId } from './providerIds.ts';

interface ProviderEngine {
    runner: AgentRunner;
    // False when the provider is not signed in. A turn then ends with a notice, it never moves to another provider.
    isConnected: () => Promise<boolean>;
}

// An engine that holds a process or a server between turns closes it when CloudBot stops.
interface ClosableRunner extends AgentRunner {
    close?: () => Promise<void>;
}

interface ProviderRunnerOptions {
    engines: Partial<Record<ProviderId, ProviderEngine>>;
    providerFor: (botId: string) => Promise<ProviderId>;
}

// A session id is tagged with its provider, so a bot that moves to another provider starts a new session
// instead of resuming one the new engine does not know.
function tagSession(provider: ProviderId, sessionId: string): string {
    return `${provider}:${sessionId}`;
}

function untagSession(provider: ProviderId, sessionId: string | undefined): string | undefined {
    if (sessionId === undefined) {
        return undefined;
    }

    const prefix = `${provider}:`;

    if (sessionId.startsWith(prefix)) {
        return sessionId.slice(prefix.length);
    }

    // Sessions saved before providers existed are Claude sessions.
    return provider === 'claude' && !/^[a-z]+:/.test(sessionId) ? sessionId : undefined;
}

// Runs each turn on the engine of the provider the bot uses.
class ProviderRunner implements AgentRunner {
    private readonly options: ProviderRunnerOptions;

    constructor(options: ProviderRunnerOptions) {
        this.options = options;
    }

    async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
        const provider = await this.options.providerFor(request.botId);
        const engine = this.options.engines[provider];
        const label = PROVIDER_LABELS[provider];

        if (engine === undefined) {
            yield { type: 'turn_error', message: `This bot uses ${label}, which this server does not have. Ask me to switch this bot to another provider.`, isUsageLimit: false };

            return;
        }

        if (!await engine.isConnected()) {
            yield { type: 'turn_error', message: `This bot uses ${label}, which is not connected. Ask me to connect ${label} or to switch this bot to another provider.`, isUsageLimit: false };

            return;
        }

        const sessionId = untagSession(provider, request.sessionId);
        const providerRequest: TurnRequest = { ...request };

        if (sessionId === undefined) {
            delete providerRequest.sessionId;
        } else {
            providerRequest.sessionId = sessionId;
        }

        for await (const event of engine.runner.runTurn(providerRequest)) {
            yield event.type === 'session' ? { ...event, sessionId: tagSession(provider, event.sessionId) } : event;
        }
    }

    async close(): Promise<void> {
        const runners = Object.values(this.options.engines)
            .map(engine => engine.runner as ClosableRunner);
        const closing = runners.map(runner => runner.close?.() ?? Promise.resolve());

        await Promise.all(closing);
    }
}

export { ProviderRunner, tagSession, untagSession };
export type { ProviderEngine, ProviderRunnerOptions };
