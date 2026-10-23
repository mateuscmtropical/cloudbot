import { describe, expect, it } from 'vitest';

import { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';

describe('ProviderModelCatalogs', () => {
    it('keeps the most recent non-empty catalog for each provider', () => {
        const catalogs = new ProviderModelCatalogs();

        catalogs.set('opencode', { models: [{ id: 'deepseek-v4', label: 'DeepSeek V4', efforts: [] }], defaultModel: 'deepseek-v4', defaultEffort: null });
        catalogs.set('chatgpt', { models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'] }], defaultModel: 'gpt-6-luna', defaultEffort: 'low' });
        catalogs.set('opencode', { models: [], defaultModel: null, defaultEffort: null });

        expect(catalogs.get('opencode')?.models[0]?.id)
            .toBe('deepseek-v4');
        expect(catalogs.get('chatgpt')?.models[0]?.id)
            .toBe('gpt-6-luna');
    });

    it('keeps the first provider defaults while refreshing the reported current values', () => {
        const catalogs = new ProviderModelCatalogs();

        catalogs.set('opencode', {
            models: [{ id: 'one', label: 'One', efforts: ['low'] }],
            defaultModel: 'one',
            defaultEffort: 'low',
            currentModel: 'one',
            currentEffort: 'low',
        });
        catalogs.set('opencode', {
            models: [{ id: 'one', label: 'One', efforts: ['low'] }, { id: 'two', label: 'Two', efforts: ['low'] }],
            defaultModel: 'two',
            defaultEffort: null,
            currentModel: 'two',
            currentEffort: null,
        });

        expect(catalogs.get('opencode'))
            .toMatchObject({ defaultModel: 'one', defaultEffort: 'low', currentModel: 'two', currentEffort: null });
        expect(catalogs.get('opencode')?.models)
            .toHaveLength(2);
    });

    it('replaces a cached default when the provider no longer offers it', () => {
        const catalogs = new ProviderModelCatalogs();

        catalogs.set('opencode', {
            models: [{ id: 'old', label: 'Old', efforts: ['high'] }],
            defaultModel: 'old',
            defaultEffort: 'high',
        });
        catalogs.set('opencode', {
            models: [{ id: 'new', label: 'New', efforts: ['low'] }],
            defaultModel: 'new',
            defaultEffort: 'low',
        });

        expect(catalogs.get('opencode'))
            .toMatchObject({ defaultModel: 'new', defaultEffort: 'low' });
    });

    it('clears a provider catalog when its authentication method changes', () => {
        const catalogs = new ProviderModelCatalogs();

        catalogs.useMethod('chatgpt', 'apiKey');
        catalogs.set('chatgpt', { models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['high'] }], defaultModel: 'gpt-6-sol', defaultEffort: 'high' });
        catalogs.useMethod('chatgpt', 'signIn');

        expect(catalogs.get('chatgpt'))
            .toBeUndefined();
    });

    it('rejects a catalog response from before an auth method change', () => {
        const catalogs = new ProviderModelCatalogs();

        catalogs.useMethod('chatgpt', 'apiKey');
        const requestRevision = catalogs.revision('chatgpt');

        catalogs.useMethod('chatgpt', 'signIn');
        catalogs.set('chatgpt', { models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['low'] }], defaultModel: 'gpt-6-luna', defaultEffort: 'low' });
        const oldResponse = catalogs.setIfRevision('chatgpt', { models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['high'] }], defaultModel: 'gpt-6-sol', defaultEffort: 'high' }, requestRevision);

        expect(oldResponse)
            .toBeUndefined();
        expect(catalogs.getIfRevision('chatgpt', requestRevision))
            .toBeUndefined();
        expect(catalogs.get('chatgpt')?.models.map(model => model.id))
            .toEqual(['gpt-6-luna']);
    });
});
