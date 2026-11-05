import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from './AgentEvent.ts';
import type { AgentRunner, TurnRequest } from './AgentRunner.ts';
import { runHelperTurn } from './createHelperRunTool.ts';

function runnerWith(events: AgentEvent[], seen: TurnRequest[] = []): AgentRunner {
    return {
        async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
            seen.push(request);
            await Promise.resolve();
            yield* events;
        },
    };
}

const REQUEST: TurnRequest = { botId: 'bot-1', provider: 'gemini', workspaceDir: '/work', prompt: 'Read the page.', abortSignal: new AbortController().signal };

describe('runHelperTurn', () => {
    it('returns the report, shows activity and counts the cost', async () => {
        const seen: TurnRequest[] = [];
        const onActivity = vi.fn();
        const onCost = vi.fn();
        const runner = runnerWith([{ type: 'session', sessionId: 's1' }, { type: 'text', text: 'Found it.' }, { type: 'turn_finished', costUsd: 0.5 }], seen);

        const result = await runHelperTurn(runner, REQUEST, { onActivity, onCost });

        expect(result)
            .toEqual({ content: [{ type: 'text', text: 'Found it.' }] });
        expect(seen[0]?.provider)
            .toBe('gemini');
        expect(onActivity)
            .toHaveBeenCalledTimes(3);
        expect(onCost)
            .toHaveBeenCalledWith(0.5);
    });

    it('reports the failure of the helper as a tool error', async () => {
        const runner = runnerWith([{ type: 'turn_error', message: 'Not connected.', isUsageLimit: false }]);

        const result = await runHelperTurn(runner, REQUEST, { onActivity: vi.fn(), onCost: vi.fn() });

        expect(result)
            .toEqual({ content: [{ type: 'text', text: 'Not connected.' }], isError: true });
    });
});
