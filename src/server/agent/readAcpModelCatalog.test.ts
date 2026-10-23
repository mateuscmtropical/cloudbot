import { describe, expect, it } from 'vitest';

import { readAcpModelCatalog } from './readAcpModelCatalog.ts';

describe('readAcpModelCatalog', () => {
    it('reads model and reasoning choices from ACP config options', () => {
        const catalog = readAcpModelCatalog({
            configOptions: [
                { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opencode/deepseek-v4', options: [{ value: 'opencode/deepseek-v4', name: 'DeepSeek V4' }] },
                { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
            ],
        });

        expect(catalog)
            .toEqual({
                models: [{ id: 'opencode/deepseek-v4', label: 'DeepSeek V4', efforts: ['low', 'high'] }],
                defaultModel: 'opencode/deepseek-v4',
                defaultEffort: 'low',
                currentModel: 'opencode/deepseek-v4',
                currentEffort: 'low',
                modelConfigId: 'model',
                effortConfigId: 'effort',
            });
    });

    it('reads the legacy model list for session/set_model agents', () => {
        const catalog = readAcpModelCatalog({
            models: {
                currentModelId: 'deepseek-v4',
                availableModels: [{ modelId: 'deepseek-v4', name: 'DeepSeek V4' }],
            },
        });

        expect(catalog)
            .toEqual({
                models: [{ id: 'deepseek-v4', label: 'DeepSeek V4', efforts: [] }],
                defaultModel: 'deepseek-v4',
                defaultEffort: null,
                currentModel: 'deepseek-v4',
                currentEffort: null,
                usesLegacySetModel: true,
            });
    });

    it('returns no catalog when the agent does not report model options', () => {
        expect(readAcpModelCatalog({ configOptions: [{ id: 'mode', type: 'select', options: [{ value: 'build' }] }] }))
            .toBeUndefined();
    });
});
