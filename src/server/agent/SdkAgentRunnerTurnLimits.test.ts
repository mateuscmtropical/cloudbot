import { describe, expect, it } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { buildQueryOptions, mapSdkMessage } from './SdkAgentRunner.ts';
import type { TurnRequest } from './AgentRunner.ts';

function resultOf(subtype: string): SDKMessage {
    return { type: 'result', subtype, is_error: true, errors: [], duration_ms: 1, total_cost_usd: 0, session_id: 'session-1' } as unknown as SDKMessage;
}

describe('SdkAgentRunner turn limits', () => {
    it('maps the SDK step limit stop to a steps turn_limit event', () => {
        expect(mapSdkMessage(resultOf('error_max_turns')))
            .toEqual([{ type: 'turn_limit', limit: 'steps' }]);
    });

    it('maps the SDK spending limit stop to a spending turn_limit event', () => {
        expect(mapSdkMessage(resultOf('error_max_budget_usd')))
            .toEqual([{ type: 'turn_limit', limit: 'spending' }]);
    });

    it('passes the step and spending limits to the SDK as maxTurns and maxBudgetUsd', () => {
        const request: TurnRequest = {
            botId: 'bot-1',
            workspaceDir: '/data/bots/bot-1',
            prompt: 'Hi',
            abortSignal: new AbortController().signal,
            maxSteps: 4,
            maxSpendUsd: 0.5,
        };

        expect(buildQueryOptions(request, {}, new AbortController()))
            .toMatchObject({ maxTurns: 4, maxBudgetUsd: 0.5 });
    });

    it('leaves the SDK limits out when the turn has none', () => {
        const request: TurnRequest = {
            botId: 'bot-1',
            workspaceDir: '/data/bots/bot-1',
            prompt: 'Hi',
            abortSignal: new AbortController().signal,
        };
        const options = buildQueryOptions(request, {}, new AbortController());

        expect(options)
            .not.toHaveProperty('maxTurns');
        expect(options)
            .not.toHaveProperty('maxBudgetUsd');
    });
});
