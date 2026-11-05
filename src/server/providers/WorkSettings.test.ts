import { describe, expect, it } from 'vitest';

import type { EffortChoices, ModelChoices } from '../models/modelChoices.ts';
import { ProviderModelCatalogs } from './ProviderModelCatalogs.ts';
import { WORK_KINDS, WorkSettings } from './WorkSettings.ts';
import type { ProviderId } from './providerIds.ts';

interface TestSetup {
    workSettings: WorkSettings;
    models: () => ModelChoices;
    setConnected: (providers: ProviderId[]) => void;
}

const NO_MODELS: ModelChoices = { chat: null, routines: null, review: null, browsing: null, documents: null, search: null, checkins: null, webhooks: null };
const NO_EFFORTS: EffortChoices = { chat: null, routines: null, review: null, browsing: null, documents: null, search: null, checkins: null, webhooks: null };

function setup(chatProvider: ProviderId = 'claude', connectedAtStart: ProviderId[] = ['claude', 'gemini', 'kimi']): TestSetup {
    const values = new Map<string, string>();
    let connectedNow = connectedAtStart;
    let models: ModelChoices = NO_MODELS;
    let efforts: EffortChoices = NO_EFFORTS;
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
        connected: () => Promise.resolve(connectedNow),
    });

    return {
        workSettings,
        models: () => models,
        setConnected: (providers) => {
            connectedNow = providers;
        },
    };
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

    it('accepts a choice for every kind of work, the new ones included', async () => {
        const { workSettings } = setup();
        const problems = await Promise.all(WORK_KINDS.map(kind => workSettings.save('bot-1', kind, { provider: 'gemini', model: 'flash', effort: 'low' })));

        expect(problems)
            .toEqual(WORK_KINDS.map(() => undefined));
        expect((await workSettings.read('bot-1', 'checkins')).provider)
            .toBe('gemini');
        expect((await workSettings.read('bot-1', 'webhooks')).provider)
            .toBe('gemini');
        expect((await workSettings.read('bot-1', 'search')).provider)
            .toBe('gemini');
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
        await workSettings.save('bot-1', 'search', { provider: null, model: 'sonnet', effort: null });
        await workSettings.save('bot-1', 'checkins', { provider: null, model: 'haiku', effort: null });

        expect(models().browsing)
            .toBe('haiku');
        expect(models().search)
            .toBe('sonnet');
        expect(models().checkins)
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
            .toBe('Review runs only on Claude, ChatGPT or Gemini.');
        expect((await workSettings.read('bot-1', 'routines')).followsChat)
            .toBe(true);
    });

    it('refuses a provider the owner is not signed in to, and saves nothing', async () => {
        const { workSettings } = setup('claude', ['claude']);

        expect(await workSettings.save('bot-1', 'routines', { provider: 'gemini', model: 'flash', effort: 'low' }))
            .toBe('Connect that provider first.');
        expect((await workSettings.read('bot-1', 'routines')).followsChat)
            .toBe(true);
    });

    it('checks a choice without saving it', async () => {
        const { workSettings } = setup('claude', ['claude', 'gemini']);

        expect(await workSettings.checkChoice('bot-1', { provider: 'gemini', model: 'flash', effort: 'low' }))
            .toBeUndefined();
        expect(await workSettings.checkChoice('bot-1', { provider: 'gemini', model: 'nope', effort: null }))
            .toBe('Choose a model from the list of that provider.');
        expect(await workSettings.checkChoice('bot-1', { provider: 'kimi', model: null, effort: null }))
            .toBe('Connect that provider first.');
        expect(await workSettings.checkChoice('bot-1', { provider: null, model: 'opus', effort: 'max' }))
            .toBeUndefined();
        expect((await workSettings.read('bot-1', 'routines')).followsChat)
            .toBe(true);
    });

    it('treats a provider that is no longer connected as following the chat', async () => {
        const { workSettings, setConnected } = setup('claude', ['claude', 'gemini']);

        await workSettings.save('bot-1', 'routines', { provider: 'gemini', model: 'flash', effort: 'low' });
        setConnected(['claude']);

        expect(await workSettings.read('bot-1', 'routines'))
            .toEqual({ provider: 'claude', followsChat: true, model: null, effort: null });

        const summaries = await workSettings.describe('bot-1');

        expect(summaries.find(summary => summary.kind === 'routines')?.provider)
            .toBeNull();
    });

    it('lists every kind of work and only the connected providers each one may pick', async () => {
        const { workSettings } = setup('claude', ['claude', 'kimi']);
        const summaries = await workSettings.describe('bot-1');
        const routines = summaries.find(summary => summary.kind === 'routines');
        const review = summaries.find(summary => summary.kind === 'review');

        expect(summaries.map(summary => summary.kind))
            .toEqual(WORK_KINDS);
        expect(routines?.choosableProviders)
            .toEqual(['claude', 'kimi']);
        expect(review?.choosableProviders)
            .toEqual(['claude']);
    });

    it('offers the model options of each provider the owner may pick', async () => {
        const { workSettings } = setup('claude', ['claude', 'gemini']);
        const summaries = await workSettings.describe('bot-1');
        const routines = summaries.find(summary => summary.kind === 'routines');

        expect(routines?.providerModels.claude?.map(option => option.id))
            .toEqual(['fable', 'opus', 'sonnet', 'haiku']);
        expect(routines?.providerModels.gemini)
            .toEqual([{ id: 'flash', label: 'Flash', efforts: ['low'] }]);
        expect(Object.keys(routines?.providerModels ?? {}))
            .toEqual(['claude', 'gemini']);
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
