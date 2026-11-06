import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contextTokensOf, mapCliMessage, rememberResetsAt, withContextTokens, withResetsAt } from './mapCliMessage.ts';
import type { CliMessage } from './mapCliMessage.ts';

const FIXTURE_FOLDER = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-stream');

function resultOf(subtype: string): CliMessage {
    return { type: 'result', subtype, is_error: true, errors: [], duration_ms: 1, total_cost_usd: 0 } as unknown as CliMessage;
}

// The lines of a recorded stream, parsed the way the engine parses them.
function fixtureMessages(name: string): CliMessage[] {
    const lines = readFileSync(join(FIXTURE_FOLDER, `${name}.jsonl`), 'utf8')
        .split('\n')
        .filter(line => line !== '');

    return lines.map(line => JSON.parse(line) as CliMessage);
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

describe('contextTokensOf', () => {
    it('counts the fresh, written and read input tokens of a main call', () => {
        const [, mainCall] = fixtureMessages('context');

        expect(contextTokensOf(mainCall as CliMessage))
            .toBe(32003);
    });

    it('leaves out a helper agent call and any message without usage', () => {
        const [, , helperCall] = fixtureMessages('context');
        const textOnly = { type: 'assistant', message: { content: [] }, parent_tool_use_id: null } as unknown as CliMessage;

        expect(contextTokensOf(helperCall as CliMessage))
            .toBeUndefined();
        expect(contextTokensOf(textOnly))
            .toBeUndefined();
        expect(contextTokensOf({ type: 'user', message: { content: '' } } as unknown as CliMessage))
            .toBeUndefined();
    });
});

describe('withContextTokens', () => {
    it('puts the context size on a finished turn only', () => {
        expect(withContextTokens({ type: 'turn_finished', durationMs: 1000 }, 32003))
            .toEqual({ type: 'turn_finished', durationMs: 1000, contextTokens: 32003 });
        expect(withContextTokens({ type: 'text', text: 'hi' }, 32003))
            .toEqual({ type: 'text', text: 'hi' });
        expect(withContextTokens({ type: 'turn_finished' }, undefined))
            .toEqual({ type: 'turn_finished' });
    });
});
