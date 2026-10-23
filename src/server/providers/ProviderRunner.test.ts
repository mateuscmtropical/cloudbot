import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { ProviderRunner, untagSession } from './ProviderRunner.ts';
import type { ProviderId } from './providerIds.ts';

interface RecordingRunner extends AgentRunner {
    requests: TurnRequest[];
}

function recordingRunner(sessionId: string): RecordingRunner {
    const requests: TurnRequest[] = [];

    return {
        requests,
        async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
            requests.push(request);
            await Promise.resolve();
            yield { type: 'session', sessionId };
            yield { type: 'text', text: 'hi' };
        },
    };
}

function makeRequest(sessionId?: string): TurnRequest {
    return { botId: 'bot-1', workspaceDir: '/tmp', prompt: 'Hello', abortSignal: new AbortController().signal, ...(sessionId === undefined ? {} : { sessionId }) };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];

    for await (const event of events) {
        collected.push(event);
    }

    return collected;
}

function makeRunner(provider: ProviderId, connected = true): { runner: ProviderRunner; claude: RecordingRunner; chatgpt: RecordingRunner } {
    const claude = recordingRunner('claude-session');
    const chatgpt = recordingRunner('thread-1');
    const runner = new ProviderRunner({
        engines: {
            claude: { runner: claude, isConnected: () => Promise.resolve(true) },
            chatgpt: { runner: chatgpt, isConnected: () => Promise.resolve(connected) },
        },
        providerFor: () => Promise.resolve(provider),
    });

    return { runner, claude, chatgpt };
}

describe('ProviderRunner', () => {
    it('runs the turn on the engine of the bot\'s provider and tags its session', async () => {
        const { runner, claude, chatgpt } = makeRunner('chatgpt');

        const events = await collect(runner.runTurn(makeRequest()));

        expect(chatgpt.requests)
            .toHaveLength(1);
        expect(claude.requests)
            .toHaveLength(0);
        expect(events[0])
            .toEqual({ type: 'session', sessionId: 'chatgpt:thread-1' });
    });

    it('applies the saved model and effort for the current non-Claude provider', async () => {
        const chatgpt = recordingRunner('thread-1');
        const runner = new ProviderRunner({
            engines: { chatgpt: { runner: chatgpt, isConnected: () => Promise.resolve(true) } },
            providerFor: () => Promise.resolve('chatgpt'),
            providerChoiceFor: () => Promise.resolve({ model: 'gpt-6-luna', effort: 'low', defaultModel: 'gpt-6-sol', defaultEffort: 'medium' }),
        });

        await collect(runner.runTurn(makeRequest()));

        expect(chatgpt.requests[0])
            .toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    });

    it('passes saved null choices so the engine can restore its provider defaults', async () => {
        const chatgpt = recordingRunner('thread-1');
        const runner = new ProviderRunner({
            engines: { chatgpt: { runner: chatgpt, isConnected: () => Promise.resolve(true) } },
            providerFor: () => Promise.resolve('chatgpt'),
            providerChoiceFor: () => Promise.resolve({ model: null, effort: null, defaultModel: 'gpt-6-sol', defaultEffort: 'medium' }),
        });

        await collect(runner.runTurn(makeRequest()));

        expect(chatgpt.requests[0])
            .toMatchObject({ model: null, effort: null, providerDefaultModel: 'gpt-6-sol', providerDefaultEffort: 'medium' });
    });

    it('does not pass Claude model settings to a non-Claude provider without its own choice', async () => {
        const chatgpt = recordingRunner('thread-1');
        const runner = new ProviderRunner({
            engines: { chatgpt: { runner: chatgpt, isConnected: () => Promise.resolve(true) } },
            providerFor: () => Promise.resolve('chatgpt'),
            providerChoiceFor: () => Promise.resolve(undefined),
        });
        const request = makeRequest();
        const requestWithOldSettings = { ...request, model: 'sonnet', effort: 'high' };

        await collect(runner.runTurn(requestWithOldSettings));

        expect(chatgpt.requests[0]?.model)
            .toBeUndefined();
        expect(chatgpt.requests[0]?.effort)
            .toBeUndefined();
    });

    it('resumes only a session of the same provider', async () => {
        const { runner, chatgpt } = makeRunner('chatgpt');

        await collect(runner.runTurn(makeRequest('chatgpt:thread-1')));
        await collect(runner.runTurn(makeRequest('claude:abc')));

        expect(chatgpt.requests[0]?.sessionId)
            .toBe('thread-1');
        expect(chatgpt.requests[1]?.sessionId)
            .toBeUndefined();
    });

    it('starts Grok with a new session after a switch from Claude', async () => {
        const grok = recordingRunner('grok-session');
        const runner = new ProviderRunner({
            engines: { grok: { runner: grok, isConnected: () => Promise.resolve(true) } },
            providerFor: () => Promise.resolve('grok'),
        });

        await collect(runner.runTurn(makeRequest('claude:old-session')));

        expect(grok.requests[0]?.sessionId)
            .toBeUndefined();
        expect(grok.requests[0]?.workspaceDir)
            .toBe('/tmp');
    });

    it('treats an untagged session as an older Claude session', () => {
        expect(untagSession('claude', 'abc'))
            .toBe('abc');
        expect(untagSession('chatgpt', 'abc'))
            .toBeUndefined();
    });

    it('ends the turn with a notice when the provider is signed out, without using another provider', async () => {
        const { runner, claude, chatgpt } = makeRunner('chatgpt', false);

        const events = await collect(runner.runTurn(makeRequest()));

        expect(events)
            .toEqual([{ type: 'turn_error', message: 'This bot uses ChatGPT, which is not connected. Ask me to connect ChatGPT or to switch this bot to another provider.', isUsageLimit: false }]);
        expect(claude.requests)
            .toHaveLength(0);
        expect(chatgpt.requests)
            .toHaveLength(0);
    });
});
