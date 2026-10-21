import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AgentEvent } from './AgentEvent.ts';
import type { TurnRequest } from './AgentRunner.ts';
import { SdkAgentRunner } from './SdkAgentRunner.ts';
import type { SdkQueryFunction } from './SdkAgentRunner.ts';

async function collectEvents(sdkMessages: SDKMessage[]): Promise<AgentEvent[]> {
    const queryFunction = vi.fn<SdkQueryFunction>(() => Readable.from(sdkMessages) as AsyncIterable<SDKMessage>);
    const runner = new SdkAgentRunner({ queryFunction });
    const request: TurnRequest = {
        botId: 'bot-1',
        workspaceDir: '/data/bots/bot-1',
        prompt: 'Hi',
        abortSignal: new AbortController().signal,
    };
    const collected: AgentEvent[] = [];

    for await (const event of runner.runTurn(request)) {
        collected.push(event);
    }

    return collected;
}

describe('SdkAgentRunner activity', () => {
    it('emits activity for a tool progress message, which maps to no event', async () => {
        const progress = { type: 'tool_progress', tool_use_id: 'tool-1', tool_name: 'Bash', elapsed_time_seconds: 90 } as unknown as SDKMessage;

        expect(await collectEvents([progress]))
            .toEqual([{ type: 'activity' }]);
    });

    it('emits activity for a stream event that is not text, such as thinking', async () => {
        const thinking = {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
        } as unknown as SDKMessage;

        expect(await collectEvents([thinking]))
            .toEqual([{ type: 'activity' }]);
    });

    it('keeps the text of a text delta as text, not activity', async () => {
        const textDelta = {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        } as unknown as SDKMessage;

        expect(await collectEvents([textDelta]))
            .toEqual([{ type: 'text_delta', text: 'Hello' }]);
    });
});
