import { describe, expect, it } from 'vitest';

import { chooseTurnModel, isModelInputError, parseModelInput } from './modelChoices.ts';

describe('parseModelInput', () => {
    it('accepts the SDK aliases and full model ids', () => {
        expect(parseModelInput({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: 'fable' }))
            .toEqual({ chat: 'haiku', routines: 'claude-sonnet-4-5', review: 'fable' });
    });

    it('treats a missing or null choice as the CLI default', () => {
        expect(parseModelInput({ chat: 'opus', routines: null }))
            .toEqual({ chat: 'opus', routines: null, review: null });
        expect(parseModelInput({}))
            .toEqual({ chat: null, routines: null, review: null });
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

describe('chooseTurnModel', () => {
    const choices = { chat: 'haiku', routines: 'opus', review: null };

    it('uses the routines choice for a routine turn', () => {
        expect(chooseTurnModel(choices, 'routine'))
            .toBe('opus');
    });

    it('uses the chat choice for a chat turn', () => {
        expect(chooseTurnModel(choices, 'chat'))
            .toBe('haiku');
    });

    it('falls back to the chat choice when the routines choice is unset', () => {
        expect(chooseTurnModel({ chat: 'haiku', routines: null, review: null }, 'routine'))
            .toBe('haiku');
    });

    it('keeps the CLI default when nothing is chosen', () => {
        expect(chooseTurnModel({ chat: null, routines: null, review: null }, 'routine'))
            .toBeUndefined();
    });
});
