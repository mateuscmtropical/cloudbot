import { describe, expect, it } from 'vitest';

import { readCodexModelCatalog } from './readCodexModelCatalog.ts';

describe('readCodexModelCatalog', () => {
    it('reads model IDs, display names, defaults, and supported reasoning levels', () => {
        const catalog = readCodexModelCatalog([
            { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: 'Balanced' }] },
            { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }] },
        ]);

        expect(catalog)
            .toEqual({
                models: [
                    { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['low', 'medium'], defaultEffort: 'medium' },
                    { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'], defaultEffort: 'low' },
                ],
                defaultModel: 'gpt-6-sol',
                defaultEffort: 'medium',
            });
    });

    it('returns no catalog for an empty or malformed response', () => {
        expect(readCodexModelCatalog([]))
            .toBeUndefined();
        expect(readCodexModelCatalog([{ displayName: 'Missing id' }]))
            .toBeUndefined();
    });
});
