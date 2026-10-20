import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './AgentEvent.ts';
import type { TurnRequest } from './AgentRunner.ts';
import { FakeAgentRunner } from './FakeAgentRunner.ts';

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const collected: AgentEvent[] = [];

    // Plain loops are banned by lint, and `for await` is the one form that fits an async iterator.
    for await (const event of events) {
        collected.push(event);
    }

    return collected;
}

function buildRequest(abortController: AbortController, sessionId?: string): TurnRequest {
    const sessionOption = sessionId ? { sessionId } : {};

    return {
        botId: 'bot-1',
        workspaceDir: '/data/bots/bot-1',
        prompt: 'Summarize my inbox',
        ...sessionOption,
        abortSignal: abortController.signal,
    };
}

describe('FakeAgentRunner', () => {
    it('streams the scripted events in order', async () => {
        const runner = new FakeAgentRunner([
            { event: { type: 'session', sessionId: 'session-1' } },
            { event: { type: 'text_delta', text: 'Hel' }, delayMs: 1 },
            { event: { type: 'text', text: 'Hello' } },
            { event: { type: 'turn_finished', costUsd: 0.01, durationMs: 20 } },
        ]);

        const events = await collectEvents(runner.runTurn(buildRequest(new AbortController())));

        expect(events)
            .toEqual([
                { type: 'session', sessionId: 'session-1' },
                { type: 'text_delta', text: 'Hel' },
                { type: 'text', text: 'Hello' },
                { type: 'turn_finished', costUsd: 0.01, durationMs: 20 },
            ]);
    });

    it('records the request it was resumed with, including the session id', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'turn_finished' } }]);

        await collectEvents(runner.runTurn(buildRequest(new AbortController(), 'session-9')));

        expect(runner.receivedRequests)
            .toHaveLength(1);
        expect(runner.receivedRequests[0])
            .toMatchObject({ sessionId: 'session-9', botId: 'bot-1' });
    });

    it('stops streaming when the abort signal fires mid-stream', async () => {
        const runner = new FakeAgentRunner([
            { event: { type: 'text', text: 'First' } },
            { event: { type: 'text', text: 'Second' }, delayMs: 60_000 },
        ]);
        const abortController = new AbortController();
        const received: AgentEvent[] = [];

        for await (const event of runner.runTurn(buildRequest(abortController))) {
            received.push(event);
            abortController.abort();
        }

        expect(received)
            .toEqual([{ type: 'text', text: 'First' }]);
    });

    it('stops a step that is waiting for its delay as soon as the signal fires', async () => {
        const runner = new FakeAgentRunner([{ event: { type: 'text', text: 'Late' }, delayMs: 60_000 }]);
        const abortController = new AbortController();

        const collecting = collectEvents(runner.runTurn(buildRequest(abortController)));

        setTimeout(() => {
            abortController.abort();
        }, 10);

        expect(await collecting)
            .toEqual([]);
    });
});
