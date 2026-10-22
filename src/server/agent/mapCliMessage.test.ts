import { describe, expect, it } from 'vitest';

import { mapCliMessage, rememberResetsAt, withResetsAt } from './mapCliMessage.ts';
import type { CliMessage } from './mapCliMessage.ts';

function resultOf(subtype: string): CliMessage {
    return { type: 'result', subtype, is_error: true, errors: [], duration_ms: 1, total_cost_usd: 0 } as unknown as CliMessage;
}

describe('mapCliMessage turn limits', () => {
    it('maps the CLI step limit stop to a steps turn_limit event', () => {
        expect(mapCliMessage(resultOf('error_max_turns')))
            .toEqual([{ type: 'turn_limit', limit: 'steps' }]);
    });

    it('maps the CLI spending limit stop to a spending turn_limit event', () => {
        expect(mapCliMessage(resultOf('error_max_budget_usd')))
            .toEqual([{ type: 'turn_limit', limit: 'spending' }]);
    });
});

describe('mapCliMessage activity and text', () => {
    it('maps a tool progress message to no event', () => {
        const progress = { type: 'tool_progress', tool_use_id: 'tool-1', tool_name: 'Bash', elapsed_time_seconds: 90 } as unknown as CliMessage;

        expect(mapCliMessage(progress))
            .toEqual([]);
    });

    it('maps a thinking delta to no event', () => {
        const thinking = {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm' } },
        } as unknown as CliMessage;

        expect(mapCliMessage(thinking))
            .toEqual([]);
    });

    it('keeps the text of a text delta as text', () => {
        const textDelta = {
            type: 'stream_event',
            event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        } as unknown as CliMessage;

        expect(mapCliMessage(textDelta))
            .toEqual([{ type: 'text_delta', text: 'Hello' }]);
    });
});

describe('mapCliMessage results and limits', () => {
    it('maps a successful result to turn_finished with its cost and duration', () => {
        const success = { type: 'result', subtype: 'success', is_error: false, result: 'Done', total_cost_usd: 0.02, duration_ms: 900 } as unknown as CliMessage;

        expect(mapCliMessage(success))
            .toEqual([{ type: 'turn_finished', costUsd: 0.02, durationMs: 900 }]);
    });

    it('marks a usage limit text as a usage limit, without the API error line', () => {
        const limit = {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'API Error: Request rejected (429) · You\'ve hit your session limit',
            total_cost_usd: 0,
            duration_ms: 1,
        } as unknown as CliMessage;

        expect(mapCliMessage(limit))
            .toEqual([{ type: 'turn_error', message: 'API Error: Request rejected (429) · You\'ve hit your session limit', isUsageLimit: true }]);
    });

    it('converts a rate limit reset time from seconds to milliseconds', () => {
        const rateLimit = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_700_000_000 } } as unknown as CliMessage;

        expect(mapCliMessage(rateLimit))
            .toEqual([{ type: 'rate_limit', status: 'rejected', resetsAt: 1_700_000_000_000 }]);
    });

    it('carries the latest reset time onto a usage limit error', () => {
        const limitEvent = { type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true } as const;
        const remembered = rememberResetsAt({ type: 'rate_limit', status: 'rejected', resetsAt: 5000 }, undefined);

        expect(withResetsAt(limitEvent, remembered))
            .toEqual({ type: 'turn_error', message: 'You\'ve hit your limit', isUsageLimit: true, resetsAt: 5000 });
    });
});
