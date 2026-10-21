import { describe, expect, it } from 'vitest';

import type { TurnLimits } from '../../shared/limitTypes.ts';
import { chooseTurnLimit, describeLimitStop, describeLimits, isLimitInputError, parseLimitInput } from './turnLimits.ts';

const FULL_PAYLOAD = {
    chat: { minutes: 30, usd: 2.5, steps: 40 },
    routines: { minutes: null, usd: 0.75, steps: 10 },
};

describe('parseLimitInput', () => {
    it('keeps every limit it is given and reads a null field as no limit', () => {
        expect(parseLimitInput(FULL_PAYLOAD))
            .toEqual(FULL_PAYLOAD);
    });

    it('reads an empty body as no limit at all', () => {
        expect(parseLimitInput({}))
            .toEqual({
                chat: { minutes: null, usd: null, steps: null },
                routines: { minutes: null, usd: null, steps: null },
            });
    });

    it('refuses a value out of range or not whole and names the field', () => {
        expect(parseLimitInput({ chat: { minutes: 0 } }))
            .toEqual({ error: 'chat.minutes must be a whole number from 1 to 1440, or null for no limit.' });
        expect(parseLimitInput({ routines: { steps: 2.5 } }))
            .toEqual({ error: 'routines.steps must be a whole number from 1 to 1000, or null for no limit.' });
        expect(parseLimitInput({ chat: { usd: 'two' } }))
            .toEqual({ error: 'chat.usd must be a number from 0.01 to 1000, or null for no limit.' });
    });

    it('refuses an unknown slot, an unknown limit name and a slot that is not an object', () => {
        expect(isLimitInputError(parseLimitInput({ desk: {} })))
            .toBe(true);
        expect(isLimitInputError(parseLimitInput({ chat: { seconds: 5 } })))
            .toBe(true);
        expect(isLimitInputError(parseLimitInput({ chat: 30 })))
            .toBe(true);
    });

    it('refuses a body that is not an object', () => {
        expect(isLimitInputError(parseLimitInput(['chat'])))
            .toBe(true);
        expect(isLimitInputError(parseLimitInput(null)))
            .toBe(true);
    });
});

describe('chooseTurnLimit', () => {
    const limits: TurnLimits = {
        chat: { minutes: 10, usd: null, steps: null },
        routines: { minutes: 60, usd: 1, steps: 20 },
    };

    it('uses the chat limit for chat turns and the routines limit for everything else', () => {
        expect(chooseTurnLimit(limits, 'chat'))
            .toEqual(limits.chat);
        expect(chooseTurnLimit(limits, 'routine'))
            .toEqual(limits.routines);
        expect(chooseTurnLimit(limits, 'webhook'))
            .toEqual(limits.routines);
    });
});

describe('describeLimitStop and describeLimits', () => {
    it('names the limit and its value in the stop message', () => {
        expect(describeLimitStop({ kind: 'minutes', value: 1 }))
            .toContain('the time limit of 1 minute.');
        expect(describeLimitStop({ kind: 'usd', value: 0.5 }))
            .toContain('the spending limit of $0.5');
        expect(describeLimitStop({ kind: 'steps', value: 12 }))
            .toContain('the step limit of 12 steps');
    });

    it('describes the limits, and says when one is not set', () => {
        expect(describeLimits({
            chat: { minutes: 30, usd: null, steps: 40 },
            routines: { minutes: null, usd: 0.75, steps: null },
        }))
            .toBe('chat 30 minutes, no spending limit, 40 steps, routines no time limit, $0.75, no step limit');
    });
});
