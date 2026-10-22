import { describe, expect, it } from 'vitest';

import { chooseTurnEffort, chooseTurnModel, isModelInputError, parseEffortInput, parseModelInput, toEffortFields } from './modelChoices.ts';
import type { EffortChoices } from './modelChoices.ts';

describe('parseModelInput', () => {
    it('accepts the SDK aliases and full model ids', () => {
        expect(parseModelInput({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: 'fable', browsing: null, documents: null }))
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: 'fable', browsing: null, documents: null });
    });

    it('treats a missing or null choice as the CLI default', () => {
        expect(parseModelInput({ chat: 'opus', routines: null }))
            .toEqual({ chat: 'opus', routines: null, review: null, browsing: null, documents: null });
        expect(parseModelInput({}))
            .toEqual({ chat: null, routines: null, review: null, browsing: null, documents: null });
    });

    it('refuses a name that is neither an alias nor a full model id', () => {
        const parsed = parseModelInput({ chat: 'gpt-4o' });

        expect(isModelInputError(parsed))
            .toBe(true);
        expect(parsed)
            .toHaveProperty('error', expect.stringContaining('The chat model'));
    });

    it('refuses text that could reach the CLI as an option', () => {
        expect(isModelInputError(parseModelInput({ review: 'claude-x --dangerous' })))
            .toBe(true);
        expect(isModelInputError(parseModelInput({ review: '' })))
            .toBe(true);
    });

    it('refuses a model id longer than the limit', () => {
        const longId = `claude-${'a'.repeat(100)}`;

        expect(isModelInputError(parseModelInput({ routines: longId })))
            .toBe(true);
    });

    it('refuses a body that is not an object', () => {
        expect(isModelInputError(parseModelInput(['haiku'])))
            .toBe(true);
        expect(isModelInputError(parseModelInput(null)))
            .toBe(true);
        expect(isModelInputError(parseModelInput('haiku')))
            .toBe(true);
    });
});

describe('parseEffortInput', () => {
    it('accepts each effort level and reads the flat field names', () => {
        expect(parseEffortInput({ chatEffort: 'low', routinesEffort: 'medium', reviewEffort: 'high', browsingEffort: 'xhigh', documentsEffort: 'max' }))
            .toEqual({ chat: 'low', routines: 'medium', review: 'high', browsing: 'xhigh', documents: 'max' });
    });

    it('treats a missing or null effort as the CLI default', () => {
        expect(parseEffortInput({ chatEffort: 'high' }))
            .toEqual({ chat: 'high', routines: null, review: null, browsing: null, documents: null });
        expect(parseEffortInput({}))
            .toEqual({ chat: null, routines: null, review: null, browsing: null, documents: null });
    });

    it('refuses a level that is not on the list', () => {
        const parsed = parseEffortInput({ routinesEffort: 'extreme' });

        expect(isModelInputError(parsed))
            .toBe(true);
        expect(parsed)
            .toHaveProperty('error', expect.stringContaining('The routines effort'));
    });

    it('refuses an effort that is not a string', () => {
        expect(isModelInputError(parseEffortInput({ chatEffort: 3 })))
            .toBe(true);
        expect(isModelInputError(parseEffortInput({ chatEffort: true })))
            .toBe(true);
    });

    it('refuses a body that is not an object', () => {
        expect(isModelInputError(parseEffortInput(null)))
            .toBe(true);
        expect(isModelInputError(parseEffortInput(['high'])))
            .toBe(true);
    });

    it('names the flat fields again when it reports them', () => {
        const efforts: EffortChoices = { chat: 'low', routines: null, review: 'max', browsing: null, documents: null };

        expect(toEffortFields(efforts))
            .toEqual({ chatEffort: 'low', routinesEffort: null, reviewEffort: 'max', browsingEffort: null, documentsEffort: null });
    });
});

describe('chooseTurnModel', () => {
    const choices = { chat: 'haiku', routines: 'opus', review: null, browsing: null, documents: null };

    it('uses the routines choice for a routine turn', () => {
        expect(chooseTurnModel(choices, 'routine'))
            .toBe('opus');
    });

    it('uses the routines choice for a webhook turn', () => {
        expect(chooseTurnModel(choices, 'webhook'))
            .toBe('opus');
    });

    it('uses the chat choice for a chat turn', () => {
        expect(chooseTurnModel(choices, 'chat'))
            .toBe('haiku');
    });

    it('falls back to the chat choice when the routines choice is unset', () => {
        expect(chooseTurnModel({ chat: 'haiku', routines: null, review: null, browsing: null, documents: null }, 'routine'))
            .toBe('haiku');
    });

    it('keeps the CLI default when nothing is chosen', () => {
        expect(chooseTurnModel({ chat: null, routines: null, review: null, browsing: null, documents: null }, 'routine'))
            .toBeUndefined();
    });

    it('uses the routines choice for a check-in', () => {
        expect(chooseTurnModel(choices, 'checkin'))
            .toBe('opus');
    });

    it('gives a check-in the cheap model when the routines choice is unset, whatever the chat choice is', () => {
        expect(chooseTurnModel({ ...choices, chat: 'opus', routines: null }, 'checkin'))
            .toBe('haiku');
    });
});

describe('chooseTurnEffort', () => {
    const efforts: EffortChoices = { chat: 'low', routines: 'max', review: null, browsing: null, documents: null };

    it('uses the routines effort for a routine or webhook turn', () => {
        expect(chooseTurnEffort(efforts, 'routine'))
            .toBe('max');
        expect(chooseTurnEffort(efforts, 'webhook'))
            .toBe('max');
    });

    it('uses the chat effort for a chat turn', () => {
        expect(chooseTurnEffort(efforts, 'chat'))
            .toBe('low');
    });

    it('never gives a check-in the chat effort', () => {
        expect(chooseTurnEffort(efforts, 'checkin'))
            .toBe('max');
        expect(chooseTurnEffort({ ...efforts, routines: null }, 'checkin'))
            .toBeUndefined();
    });

    it('falls back to the chat effort when the routines effort is unset', () => {
        expect(chooseTurnEffort({ ...efforts, routines: null }, 'routine'))
            .toBe('low');
    });

    it('keeps the CLI default when nothing is chosen', () => {
        expect(chooseTurnEffort({ ...efforts, chat: null, routines: null }, 'routine'))
            .toBeUndefined();
    });
});
