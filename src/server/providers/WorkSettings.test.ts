import { describe, expect, it } from 'vitest';

import type { EffortChoices, ModelChoices } from '../models/modelChoices.ts';
import { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';
import { WorkSettings } from './WorkSettings.ts';
import type { ProviderId } from './providerIds.ts';

interface TestSetup {
    workSettings: WorkSettings;
    models: () => ModelChoices;
}

function setup(chatProvider: ProviderId = 'claude'): TestSetup {
    const values = new Map<string, string>();
    let models: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };
    let efforts: EffortChoices = { chat: null, routines: null, review: null, browsing: null, documents: null };
    const modelCatalogs = new ProviderModelCatalogs();

    modelCatalogs.set('gemini', { models: [{ id: 'flash', label: 'Flash', efforts: ['low'] }], defaultModel: 'flash', defaultEffort: null });

    const workSettings = new WorkSettings({
        settings: {
            get: key => Promise.resolve(values.get(key)),
            set: (key, value) => {
                values.set(key, value);

                return Promise.resolve();
            },
        },
        modelStore: {
            get: () => Promise.resolve(models),
            set: (_botId, choices) => {
                models = choices;

                return Promise.resolve();
            },
            getEfforts: () => Promise.resolve(efforts),
            setEfforts: (_botId, choices) => {
                efforts = choices;

                return Promise.resolve();
            },
            getProviderChoice: () => Promise.resolve(undefined),
        },
        modelCatalogs,
        providerFor: () => Promise.resolve(chatProvider),
        available: () => ['claude', 'gemini', 'kimi'],
    });

    return { workSettings, models: () => models };
}

describe('WorkSettings', () => {
    it('follows the chat until the owner picks a provider', async () => {
        const { workSettings } = setup('gemini');

        expect(await workSettings.read('bot-1', 'routines'))
            .toEqual({ provider: 'gemini', followsChat: true, model: null, effort: null });
    });

    it('keeps the provider, model and effort of one kind of work apart from the others', async () => {
        const { workSettings } = setup();

        expect(await workSettings.save('bot-1', 'routines', { provider: 'gemini', model: 'flash', effort: 'low' }))
            .toBeUndefined();

        expect(await workSettings.read('bot-1', 'routines'))
            .toEqual({ provider: 'gemini', followsChat: false, model: 'flash', effort: 'low' });
        expect(await workSettings.read('bot-1', 'documents'))
            .toEqual({ provider: 'claude', followsChat: true, model: null, effort: null });
    });

    it('goes back to the chat with a null provider', async () => {
        const { workSettings } = setup();

        await workSettings.save('bot-1', 'browsing', { provider: 'gemini', model: null, effort: null });
        await workSettings.save('bot-1', 'browsing', { provider: null, model: null, effort: null });

        expect((await workSettings.read('bot-1', 'browsing')).followsChat)
            .toBe(true);
    });

    it('saves a Claude choice where Claude turns read it', async () => {
        const { workSettings, models } = setup();

        await workSettings.save('bot-1', 'browsing', { provider: null, model: 'haiku', effort: 'low' });

        expect(models().browsing)
            .toBe('haiku');
    });

    it('refuses what the provider does not offer and saves nothing', async () => {
        const { workSettings } = setup();

        expect(await workSettings.save('bot-1', 'routines', { provider: 'gemini', model: 'nope', effort: null }))
            .toBeDefined();
        expect(await workSettings.save('bot-1', 'routines', { provider: 'gemini', model: 'flash', effort: 'max' }))
            .toBeDefined();
        expect(await workSettings.save('bot-1', 'routines', { provider: null, model: 'gpt-6', effort: null }))
            .toBeDefined();
        expect(await workSettings.save('bot-1', 'routines', { provider: 'grok', model: null, effort: null }))
            .toBeDefined();
        expect(await workSettings.save('bot-1', 'review', { provider: 'kimi', model: null, effort: null }))
            .toBeDefined();
        expect((await workSettings.read('bot-1', 'routines')).followsChat)
            .toBe(true);
    });

    it('shows the real name of the default model once the provider reported it', async () => {
        const { workSettings } = setup();
        const before = await workSettings.describe('bot-1');

        expect(before[0]?.usedModel)
            .toBeNull();

        await workSettings.noteDefaultModel('claude', 'claude-opus-5-5');

        const after = await workSettings.describe('bot-1');

        expect(after[0]?.usedModel)
            .toBe('claude-opus-5-5');
    });

    it('shows the chat model for work that runs on the chat, but not for a review', async () => {
        const { workSettings } = setup();

        await workSettings.noteDefaultModel('claude', 'claude-opus-5-5');
        await workSettings.save('bot-1', 'routines', { provider: null, model: 'sonnet', effort: null });

        const summaries = await workSettings.describe('bot-1');
        const routines = summaries.find(summary => summary.kind === 'routines');
        const review = summaries.find(summary => summary.kind === 'review');

        expect(routines?.usedModel)
            .toBe('Sonnet');
        expect(review?.usedModel)
            .toBe('claude-opus-5-5');
    });
});
